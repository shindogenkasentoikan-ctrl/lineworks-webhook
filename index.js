import express from "express";
import { google } from "googleapis";

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 8080;

// Google Sheets
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const DEBUG_SHEET_NAME = process.env.SHEET_NAME || "debug";
const TARGET_SHEET_NAME = process.env.TARGET_SHEET_NAME || "locations";

// Google Maps Platform
const MAPS_API_KEY = process.env.MAPS_API_KEY;

if (!SPREADSHEET_ID) {
  console.warn("SPREADSHEET_ID is not set.");
}
if (!MAPS_API_KEY) {
  console.warn("MAPS_API_KEY is not set.");
}

// ---------- Helpers ----------
function getMessageText(body) {
  if (!body || typeof body !== "object") return "";

  if (
    body.content &&
    body.content.type === "text" &&
    typeof body.content.text === "string"
  ) {
    return body.content.text.trim();
  }

  if (body.content && typeof body.content.text === "string") {
    return body.content.text.trim();
  }

  if (typeof body.text === "string") {
    return body.text.trim();
  }

  if (body.message && typeof body.message.text === "string") {
    return body.message.text.trim();
  }

  return "";
}

function formatTokyoDateTime(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = formatter.formatToParts(date);
  const map = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      map[part.type] = part.value;
    }
  }

  return `${map.month}/${map.day}`;
}

function getEventType(body) {
  return body?.type || "";
}

function getAccountId(body) {
  return (
    body?.source?.accountId ||
    body?.source?.userId ||
    body?.accountId ||
    ""
  );
}

function getRoomId(body) {
  return (
    body?.source?.roomId ||
    body?.source?.channelId ||
    body?.roomId ||
    body?.channelId ||
    ""
  );
}

function getSenderName(body) {
  const candidates = [
    body?.source?.displayName,
    body?.source?.userName,
    body?.source?.name,
    body?.source?.accountName,
    body?.source?.nickname,
    body?.user?.displayName,
    body?.user?.name,
    body?.user?.userName,
    body?.displayName,
    body?.name
  ];

  for (const v of candidates) {
    if (typeof v === "string" && v.trim()) {
      return v.trim();
    }
  }

  return "";
}

function extractUrls(text) {
  if (!text) return [];
  const re = /https?:\/\/[^\s<>\u3000]+/g;
  return text.match(re) || [];
}

function isGoogleMapsUrl(url) {
  return /(^https?:\/\/)?(www\.)?(maps\.app\.goo\.gl|goo\.gl\/maps|google\.[^\/]+\/maps|maps\.google\.[^\/]+)/i.test(
    url
  );
}

function normalizeUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

async function expandShortUrl(url) {
  let current = url;

  for (let i = 0; i < 5; i++) {
    const res = await fetch(current, {
      method: "GET",
      redirect: "manual"
    });

    const status = res.status;
    const location = res.headers.get("location");

    if ([301, 302, 303, 307, 308].includes(status) && location) {
      current = location;
      continue;
    }
    break;
  }

  return current;
}

function decodeSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function getQueryParam(url, key) {
  const m = url.match(new RegExp(`[?&]${key}=([^&#]+)`, "i"));
  return m ? decodeSafe(m[1]) : "";
}

function extractLikelyQueryFromMapsUrl(text) {
  let m = text.match(/\/place\/([^\/?#]+)/i);
  if (m) return cleanupMapsText(m[1]);

  m = text.match(/\/search\/([^\/?#]+)/i);
  if (m) return cleanupMapsText(m[1]);

  return "";
}

function cleanupMapsText(s) {
  return decodeSafe(s)
    .replace(/\+/g, " ")
    .replace(/_/g, " ")
    .trim();
}

function extractPlaceIdFromText(text) {
  // query parameter に place_id がある場合だけ Place ID とみなす
  let m = text.match(/(?:place_id|query_place_id)=([^&#]+)/i);
  if (m) return decodeSafe(m[1]);

  // /data=...1s の後ろに 0x...:0x... が来ることがあるが、
  // これは Places API (New) の Place Details にそのまま渡せる
  // Place ID ではないケースがあるため使わない
  return "";
}

function extractLatLng(text) {
  let m = text.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  if (m) return { lat: m[1], lng: m[2] };

  m = text.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/);
  if (m) return { lat: m[1], lng: m[2] };

  return null;
}

// ---------- Google Sheets ----------
async function Sheet(sheetName, rowValues) {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });

  const sheets = google.sheets({ version: "v4", auth });

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:Z`,
    valueInputOption: "RAW",
    requestBody: {
      values: [rowValues]
    }
  });
}

/**
 * 一覧シートの I列(URL) に同じURLが既にあるか確認
 */
async function urlAlreadyExists(sheetName, url) {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"]
  });

  const sheets = google.sheets({ version: "v4", auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!H:H`
  });

  const values = res.data.values || [];
  const normalized = normalizeUrl(url);

  return values.some((row) => normalizeUrl(row?.[0] || "") === normalized);
}

// ---------- Google Maps / Places ----------
async function getPlaceDetailsByPlaceId(placeId) {
  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(
    placeId
  )}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "X-Goog-Api-Key": MAPS_API_KEY,
      "X-Goog-FieldMask": "displayName,formattedAddress,plusCode"
    }
  });

  if (!res.ok) {
    throw new Error(`Place Details failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();

  return {
    name: data?.displayName?.text || "",
    address: data?.formattedAddress || "",
    plusCode:
      data?.plusCode?.globalCode ||
      data?.plusCode?.compoundCode ||
      ""
  };
}

async function searchPlaceByText(query) {
  const url = "https://places.googleapis.com/v1/places:searchText";

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": MAPS_API_KEY,
      "X-Goog-FieldMask":
        "places.displayName,places.formattedAddress,places.plusCode"
    },
    body: JSON.stringify({
      textQuery: query,
      languageCode: "ja",
      regionCode: "JP"
    })
  });

  if (!res.ok) {
    throw new Error(`Text Search failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const place = data?.places?.[0];

  if (!place) {
    return {
      name: "",
      address: "",
      plusCode: ""
    };
  }

  return {
    name: place?.displayName?.text || "",
    address: place?.formattedAddress || "",
    plusCode:
      place?.plusCode?.globalCode ||
      place?.plusCode?.compoundCode ||
      ""
  };
}

async function reverseGeocode(lat, lng) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&language=ja&key=${encodeURIComponent(
    MAPS_API_KEY
  )}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Geocoding failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const result = data?.results?.[0];

  if (!result) {
    return {
      name: "",
      address: "",
      plusCode: ""
    };
  }

  const plusCode =
    data?.plus_code?.global_code ||
    data?.plus_code?.compound_code ||
    "";

  return {
    name: "",
    address: result?.formatted_address || "",
    plusCode
  };
}

async function resolveGoogleMapsPlace(originalUrl) {
  const expandedUrl = await expandShortUrl(originalUrl);
  const decodedUrl = decodeSafe(expandedUrl);

  const placeId =
    getQueryParam(expandedUrl, "query_place_id") ||
    getQueryParam(expandedUrl, "place_id") ||
    extractPlaceIdFromText(decodedUrl);

  if (placeId) {
    try {
      const detail = await getPlaceDetailsByPlaceId(placeId);
      return {
        name: detail.name || "",
        address: detail.address || "",
        plusCode: detail.plusCode || "",
        url: originalUrl
      };
    } catch (err) {
      console.warn("Place Details fallback:", String(err));
    }
  }

  const query =
    getQueryParam(expandedUrl, "query") ||
    getQueryParam(expandedUrl, "q") ||
    extractLikelyQueryFromMapsUrl(decodedUrl);

  if (query) {
    const searched = await searchPlaceByText(query);
    return {
      name: searched.name || "",
      address: searched.address || "",
      plusCode: searched.plusCode || "",
      url: originalUrl
    };
  }

  const latlng = extractLatLng(decodedUrl);
  if (latlng) {
    const geo = await reverseGeocode(latlng.lat, latlng.lng);
    return {
      name: geo.name || "",
      address: geo.address || "",
      plusCode: geo.plusCode || "",
      url: originalUrl
    };
  }

  return {
    name: "",
    address: "",
    plusCode: "",
    url: originalUrl
  };
}

// ---------- Routes ----------
app.get("/", (_req, res) => {
  res.status(200).send("cloud run is alive");
});

app.post("/", async (req, res) => {
  const body = req.body || {};
  const rawBody = JSON.stringify(body);

  const eventType = getEventType(body);
  const text = getMessageText(body);
  const accountId = getAccountId(body);
  const roomId = getRoomId(body);
  const senderName = getSenderName(body);
  const urls = extractUrls(text);
  const mapUrls = urls.filter(isGoogleMapsUrl);

  
  try {
    // debugシートへ記録
    await appendToSheet(DEBUG_SHEET_NAME, [
      new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }),
      eventType,
      text,
      senderName,
      accountId,
      roomId,
      rawBody
    ]);

    if (eventType !== "message") {
      return res.status(200).json({ ok: true, skipped: "not message" });
    }

    if (!mapUrls.length) {
      return res.status(200).json({ ok: true, skipped: "no google maps url" });
    }

    for (const mapUrl of mapUrls) {
      const exists = await urlAlreadyExists(TARGET_SHEET_NAME, mapUrl);
      if (exists) {
        continue;
      }

      const place = await resolveGoogleMapsPlace(mapUrl);

      await appendToSheet(TARGET_SHEET_NAME, [
        new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }),                          // A
        "", // B
        "",                          // C
        senderName || "",            // D
        place.name || "",            // E
        "",                          // F
        place.address || "",         // G
        mapUrl,                      // H
        place.address ? "" : (place.plusCode || ""), // I
        ""                           // J
      ]);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);

    try {
      await appendToSheet(DEBUG_SHEET_NAME, [
        new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }),
        "ERROR",
        "",
        senderName,
        accountId,
        roomId,
        String(err)
      ]);
    } catch (e) {
      console.error("append debug error failed", e);
    }

    return res.status(200).json({
      ok: false,
      error: String(err)
    });
  }
});

app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});
