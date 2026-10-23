const https = require("https");

const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || "").trim();
const GEMINI_MODEL = (process.env.GEMINI_MODEL || "gemini-2.5-flash").trim();
const GEMINI_STUDY_MODEL = (process.env.GEMINI_STUDY_MODEL || GEMINI_MODEL).trim();

function isAiEnabled() {
  return Boolean(GEMINI_API_KEY);
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
      },
      (res) => {
        let raw = "";

        res.on("data", (chunk) => {
          raw += chunk;
        });

        res.on("end", () => {
          const statusCode = res.statusCode || 500;

          if (statusCode < 200 || statusCode >= 300) {
            return reject(
              new Error(`Gemini request failed (${statusCode}): ${raw.slice(0, 500)}`)
            );
          }

          try {
            resolve(JSON.parse(raw));
          } catch (err) {
            reject(new Error(`Failed to parse Gemini response: ${err.message}`));
          }
        });
      }
    );

    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

function extractText(response) {
  const candidates = response && Array.isArray(response.candidates) ? response.candidates : [];

  for (const candidate of candidates) {
    const parts = candidate && candidate.content && Array.isArray(candidate.content.parts)
      ? candidate.content.parts
      : [];

    const text = parts
      .map((part) => (part && typeof part.text === "string" ? part.text : ""))
      .join("")
      .trim();

    if (text) return text;
  }

  return "";
}

function sanitizeCandidates(candidates) {
  return candidates.map((item) => ({
    id: item.id,
    name: item.name,
    mimeType: item.mimeType,
    path: item.path || item.name,
    modifiedTime: item.modifiedTime || null,
    kind: item.mimeType === "application/vnd.google-apps.folder" ? "folder" : "file",
  }));
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(text.slice(start, end + 1));
    }
    throw new Error("Model response was not valid JSON");
  }
}

async function askAcademicAssistant({ query, candidates, botName }) {
  if (!isAiEnabled()) {
    throw new Error("Gemini is not configured");
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  const groundedCandidates = sanitizeCandidates(candidates);

  const body = {
    system_instruction: {
      parts: [
        {
          text:
            `You are ${botName}, an academically strong and supportive lecturer from UNN/UNEC helping students find the best materials in the school's library bot. ` +
            `You must stay grounded in the provided candidate materials only. ` +
            `Treat the provided materials as the latest materials currently available in this bot's curated UNN/UNEC library, but do not invent upload dates or claim more than the data shows. ` +
            `Give concise, professor-like guidance, answer naturally, and encourage students when appropriate. ` +
            `If the request is ambiguous, ask a short clarifying question. ` +
            `Return strict JSON only with keys: reply, action, selectedIds, confidence. ` +
            `Allowed action values: clarify, show_matches, send_file, open_folder. ` +
            `selectedIds must contain only ids from the provided candidates.`,
        },
      ],
    },
    generationConfig: {
      temperature: 0.3,
      responseMimeType: "application/json",
    },
    contents: [
      {
        role: "user",
        parts: [
          {
            text: JSON.stringify({
              userQuery: query,
              candidates: groundedCandidates,
              instructions: {
                chooseSendFileOnlyForStrongSingleFileMatches: true,
                chooseOpenFolderForStrongFolderMatches: true,
                preferShowMatchesWhenSeveralItemsAreRelevant: true,
                keepReplyUnder: 700,
              },
            }),
          },
        ],
      },
    ],
  };

  const response = await postJson(url, body);
  const text = extractText(response);
  const parsed = safeJsonParse(text);

  return {
    reply: typeof parsed.reply === "string" ? parsed.reply.trim() : "",
    action: typeof parsed.action === "string" ? parsed.action.trim() : "show_matches",
    selectedIds: Array.isArray(parsed.selectedIds) ? parsed.selectedIds.filter(Boolean) : [],
    confidence: typeof parsed.confidence === "string" ? parsed.confidence.trim() : "medium",
  };
}

async function askStudyAssistant({ query, materials, botName }) {
  if (!isAiEnabled()) {
    throw new Error("Gemini is not configured");
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/` +
    `${encodeURIComponent(GEMINI_STUDY_MODEL)}:generateContent?key=${encodeURIComponent(
      GEMINI_API_KEY
    )}`;

  const parts = [
    {
      text:
        `Student request: ${query}\n\n` +
        `You must answer as ${botName}, a supportive UNN/UNEC lecturer. ` +
        `State clearly that your answer is based on the provided course materials. ` +
        `Do not present claims as coming from the materials unless they are grounded in the provided files. ` +
        `If the material is insufficient, say so plainly. ` +
        `When appropriate, add a short "Possible exam questions" section with 3 to 5 likely questions drawn from the material. ` +
        `Keep the answer practical, academically sound, and concise enough for WhatsApp.`,
    },
  ];

  for (const material of materials) {
    parts.push({
      text: `Material title: ${material.name}\nMaterial path: ${material.path || material.name}`,
    });

    if (material.type === "inline_data") {
      parts.push({
        inline_data: {
          mime_type: material.mimeType,
          data: material.data,
        },
      });
    } else if (material.type === "text") {
      parts.push({
        text: `Material excerpt:\n${material.text}`,
      });
    }
  }

  const body = {
    system_instruction: {
      parts: [
        {
          text:
            `You are ${botName}. ` +
            `Be academically rigorous, encouraging, and concise. ` +
            `You are assisting students with the current curated UNN/UNEC material library. ` +
            `Always make it clear that the answer comes from the provided material set.`,
        },
      ],
    },
    generationConfig: {
      temperature: 0.2,
    },
    contents: [
      {
        role: "user",
        parts,
      },
    ],
  };

  const response = await postJson(url, body);
  return extractText(response).trim();
}

module.exports = {
  askAcademicAssistant,
  askStudyAssistant,
  isAiEnabled,
};
