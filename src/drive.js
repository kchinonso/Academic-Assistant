const fs = require("fs");
const path = require("path");
const mime = require("mime-types");
const { google } = require("googleapis");

const DOWNLOAD_DIR = path.join(__dirname, "..", "downloads");
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

function getDriveClientServiceAccount() {
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!keyFile) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not set");

  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });

  return google.drive({ version: "v3", auth });
}

function isFolderMime(mimeType) {
  return mimeType === "application/vnd.google-apps.folder";
}

async function listFolderChildren(drive, folderId, pageSize = 100) {
  let files = [];
  let pageToken = null;

  do {
    const res = await drive.files.list({
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      q: `'${folderId}' in parents and trashed=false`,
      fields: "nextPageToken, files(id,name,mimeType,modifiedTime,size,parents)",
      orderBy: "folder,name",
      pageSize,
      pageToken,
    });

    files.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken || null;
  } while (pageToken);

  return files;
}

async function getFileMeta(drive, fileId) {
  const res = await drive.files.get({
    fileId,
    supportsAllDrives: true,
    fields: "id,name,mimeType,size,modifiedTime,parents",
  });
  return res.data;
}

async function downloadOrExportFile(drive, file) {
  const isGoogleType = file.mimeType.startsWith("application/vnd.google-apps");

  let exportMime = null;
  let ext = path.extname(file.name);

  if (isGoogleType) {
    if (file.mimeType === "application/vnd.google-apps.document") {
      exportMime = "application/pdf";
      ext = ".pdf";
    } else if (file.mimeType === "application/vnd.google-apps.spreadsheet") {
      exportMime =
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      ext = ".xlsx";
    } else if (file.mimeType === "application/vnd.google-apps.presentation") {
      exportMime = "application/pdf";
      ext = ".pdf";
    } else {
      exportMime = "application/pdf";
      ext = ".pdf";
    }
  } else if (!ext) {
    const derived = mime.extension(file.mimeType);
    if (derived) ext = "." + derived;
  }

  const safeName = file.name.replace(/[^\w.\- ()]/g, "_");
  const outPath = path.join(
    DOWNLOAD_DIR,
    safeName.endsWith(ext) ? safeName : safeName + ext
  );

  const dest = fs.createWriteStream(outPath);

  const res = isGoogleType
    ? await drive.files.export(
        { fileId: file.id, mimeType: exportMime, supportsAllDrives: true },
        { responseType: "stream" }
      )
    : await drive.files.get(
        { fileId: file.id, alt: "media", supportsAllDrives: true },
        { responseType: "stream" }
      );

  await new Promise((resolve, reject) => {
    res.data.on("end", resolve).on("error", reject).pipe(dest);
  });

  return outPath;
}

async function downloadOrExportFileBuffer(drive, file) {
  const filePath = await downloadOrExportFile(drive, file);

  try {
    const buffer = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    let mimeType = file.mimeType;

    if (ext === ".pdf") {
      mimeType = "application/pdf";
    } else if (ext === ".txt") {
      mimeType = "text/plain";
    } else if (ext === ".json") {
      mimeType = "application/json";
    } else if (ext === ".md") {
      mimeType = "text/markdown";
    } else if (ext === ".csv") {
      mimeType = "text/csv";
    } else if (ext === ".docx") {
      mimeType =
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    } else if (ext === ".pptx") {
      mimeType =
        "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    } else if (ext === ".xlsx") {
      mimeType =
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    } else if (!mimeType || mimeType.startsWith("application/vnd.google-apps")) {
      mimeType = mime.lookup(ext) || "application/octet-stream";
    }

    return {
      buffer,
      mimeType,
      filePath,
    };
  } finally {
    try {
      fs.unlinkSync(filePath);
    } catch (_) {}
  }
}

async function crawlFolderTree(drive, rootFolderId, parentPath = "") {
  const items = [];
  const children = await listFolderChildren(drive, rootFolderId, 100);

  for (const child of children) {
    const currentPath = parentPath ? `${parentPath} / ${child.name}` : child.name;

    items.push({
      id: child.id,
      name: child.name,
      mimeType: child.mimeType,
      size: child.size || null,
      modifiedTime: child.modifiedTime || null,
      parents: child.parents || [],
      path: currentPath,
      rootFolderId,
    });

    if (isFolderMime(child.mimeType)) {
      const nested = await crawlFolderTree(drive, child.id, currentPath);
      items.push(...nested);
    }
  }

  return items;
}

module.exports = {
  getDriveClientServiceAccount,
  isFolderMime,
  listFolderChildren,
  getFileMeta,
  downloadOrExportFile,
  downloadOrExportFileBuffer,
  crawlFolderTree,
};
