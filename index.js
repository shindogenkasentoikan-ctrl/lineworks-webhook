import express from "express";
import { google } from "googleapis";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = process.env.SHEET_NAME || "debug";

const LW_API_BASE = "https://www.worksapis.com/v1.0";
const LW_BOT_ID = process.env.LW_BOT_ID;
const LW_ACCESS_TOKEN = process.env.LW_ACCESS_TOKEN;

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

function getRoomId(body) {
  return body?.source?.roomId || body?.source?.channelId || "";
}

function getAccountId(body) {
  return body?.source?.accountId || "";
}

async function appendToSheet(rowValues) {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });

  const sheets = google.sheets({ version: "v4", auth });

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:F`,
    valueInputOption: "RAW",
    requestBody: {
      values: [rowValues]
    }
  });
}

async function sendToRoom(roomId, text) {
  const url = `${LW_API_BASE}/bots/${encodeURIComponent(LW_BOT_ID)}/channels/${encodeURIComponent(roomId)}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${LW_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      content: {
        type: "text",
        text
      }
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`sendToRoom failed: ${res.status} ${body}`);
  }
}

async function sendToUser(accountId, text) {
  const url = `${LW_API_BASE}/bots/${encodeURIComponent(LW_BOT_ID)}/users/${encodeURIComponent(accountId)}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${LW_ACCESS_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      content: {
        type: "text",
        text
      }
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`sendToUser failed: ${res.status} ${body}`);
  }
}

app.get("/", (_req, res) => {
  res.status(200).send("cloud run is alive");
});

app.post("/", async (req, res) => {
  const body = req.body || {};
  const rawBody = JSON.stringify(body);
  const eventType = body.type || "";
  const text = getMessageText(body);
  const roomId = getRoomId(body);
  const accountId = getAccountId(body);

  try {
    await appendToSheet([
      new Date().toISOString(),
      eventType,
      text,
      accountId,
      roomId,
      rawBody
    ]);

// if (eventType === "message" && text) {
//   if (roomId) {
//     await sendToRoom(roomId, text);
//   } else if (accountId) {
//     await sendToUser(accountId, text);
//   }
// }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);

    try {
      await appendToSheet([
        new Date().toISOString(),
        "ERROR",
        "",
        accountId,
        roomId,
        String(err)
      ]);
    } catch (e) {
      console.error("append error log failed", e);
    }

    res.status(200).json({ ok: false, error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});
