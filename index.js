const express = require("express");
const cors = require("cors");
const sharp = require("sharp");
const { google } = require("googleapis");
const pdfImgConvert = require("pdf-img-convert");

// Build Drive auth from env var containing service account JSON
function getDriveAuth() {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!json) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON env var is not set");
  const credentials = JSON.parse(json);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 8080;

// ─── Helpers ────────────────────────────────────────────────────────────────

function getBlockText(block) {
  let text = "";
  if (!block.paragraphs) return text;
  for (const para of block.paragraphs) {
    if (!para.words) continue;
    for (const word of para.words) {
      if (!word.symbols) continue;
      let wt = "";
      for (const sym of word.symbols) {
        wt += sym.text || "";
      }
      text += wt + " ";
    }
  }
  return text.trim();
}

function getBlockPos(block) {
  if (!block.boundingBox || !block.boundingBox.normalizedVertices) return null;
  const verts = block.boundingBox.normalizedVertices;
  const x = (verts[0] && verts[0].x) || 0;
  const y = (verts[0] && verts[0].y) || 0;
  const yBottom = (verts[2] && verts[2].y) || 0;
  return { x, y, yBottom, height: yBottom - y };
}

async function callVision(base64File, pageNums, apiKey) {
  const response = await fetch(
    `https://vision.googleapis.com/v1/files:annotate?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            inputConfig: {
              content: base64File,
              mimeType: "application/pdf",
            },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
            pages: pageNums,
          },
        ],
      }),
    }
  );
  return response.json();
}

function parsePage1(pageResponse) {
  const info = { title: "", address: "", created_on: "" };
  if (!pageResponse || !pageResponse.fullTextAnnotation) return info;

  const rawText = pageResponse.fullTextAnnotation.text || "";
  const lines = rawText.split("\n").filter((l) => l.trim());

  if (lines.length >= 1) info.title = lines[0].trim();
  if (lines.length >= 2) info.address = lines[1].trim();
  if (lines.length >= 3) {
    const dateMatch = lines[2].match(/Created on:\s*(.+)/i);
    info.created_on = dateMatch ? dateMatch[1].trim() : lines[2].trim();
  }
  return info;
}

function parseContentPage(pageResponse) {
  const RIGHT_COL_START = 0.7;
  const Y_TOLERANCE = 0.012;

  if (
    !pageResponse ||
    !pageResponse.fullTextAnnotation ||
    !pageResponse.fullTextAnnotation.pages ||
    !pageResponse.fullTextAnnotation.pages[0]
  ) {
    return {};
  }

  const pageObj = pageResponse.fullTextAnnotation.pages[0];
  if (!pageObj.blocks) return {};

  // Collect right-column blocks
  const rightBlocks = [];
  for (const block of pageObj.blocks) {
    const pos = getBlockPos(block);
    if (!pos || pos.x < RIGHT_COL_START) continue;

    const text = getBlockText(block);
    if (!text) continue;

    const lower = text.toLowerCase();
    if (
      lower.includes("powered by") ||
      lower.includes("amply") ||
      lower.includes("www.") ||
      lower === ">"
    )
      continue;

    rightBlocks.push({ text, x: pos.x, y: pos.y, yBottom: pos.yBottom, height: pos.height });
  }

  rightBlocks.sort((a, b) => a.y - b.y);

  // Group into rows by Y midpoint proximity
  const rows = [];
  for (const block of rightBlocks) {
    let foundRow = false;
    for (const row of rows) {
      const rowMidY = (row[0].y + row[0].yBottom) / 2;
      const blockMidY = (block.y + block.yBottom) / 2;
      if (Math.abs(rowMidY - blockMidY) < Y_TOLERANCE) {
        row.push(block);
        foundRow = true;
        break;
      }
    }
    if (!foundRow) rows.push([block]);
  }

  const data = {};

  // Parse rows
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    const lineText = row.map((b) => b.text).join(" ");

    // Heat + Cool on same line
    const heatCoolMatch = lineText.match(
      /Heat\s*:\s*([\d,.]+\s*Btuh)\s*Cool\s*:\s*([\d,.]+\s*Btuh)/i
    );
    if (heatCoolMatch) {
      data["heat"] = heatCoolMatch[1].trim();
      data["cool"] = heatCoolMatch[2].trim();
      continue;
    }

    // Colon-style: "Capacity : 15K BTUh"
    const colonMatch = lineText.match(/^(.+?)\s*:\s+(.+)$/);
    if (colonMatch) {
      const rawLabel = colonMatch[1].trim().toLowerCase();
      const value = colonMatch[2].trim();
      const keyMap = {
        capacity: "capacity",
        "unit type": "unit_type",
        brand: "brand",
        room: "room",
        mount: "mount",
        label: "label",
        heat: "heat",
        cool: "cool",
      };
      if (keyMap[rawLabel]) data[keyMap[rawLabel]] = value;
      continue;
    }

    // Two-block rows: "Latent Cooling" + "340"
    if (row.length === 2) {
      const label = row[0].text.trim();
      const value = row[1].text.trim();
      const key = label.toLowerCase().replace(/\s+/g, "_").replace(/#/g, "#");
      const statsKeys = {
        latent_cooling: "latent_cooling",
        sensible_cooling: "sensible_cooling",
        "sensible_ratio_(_shr_)": "sensible_ratio_(shr)",
        "sensible_ratio_(shr)": "sensible_ratio_(shr)",
        cfm_heating: "cfm_heating",
        cfm_cooling: "cfm_cooling",
      };
      if (statsKeys[key]) data[statsKeys[key]] = value;
    }
  }

  // Combined stats block: Height / Floor Area / Volume / Windows / Walls
  for (const block of rightBlocks) {
    if (block.text.match(/Height/) && block.text.match(/Floor Area/)) {
      const valueBlocks = rightBlocks
        .filter(
          (b) =>
            b.x > block.x &&
            b.y >= block.y - 0.01 &&
            b.yBottom <= block.yBottom + 0.05
        )
        .sort((a, b) => a.y - b.y);

      for (const vb of valueBlocks) {
        const valText = vb.text;
        const sqftMatch = valText.match(/([\d.,]+)\s*sq\s*ft/);
        const cuftMatch = valText.match(/([\d.,]+)\s*cu\s*ft/);

        if (!data["height"]) {
          const heightMatch = valText.match(/^([\d.,]+)\s*ft/);
          if (heightMatch) data["height"] = heightMatch[1] + " ft";
        }
        if (sqftMatch && !data["floor_area"])
          data["floor_area"] = sqftMatch[1] + " sq ft";
        if (cuftMatch && !data["volume"])
          data["volume"] = cuftMatch[1] + " cu ft";

        // Standalone numbers: windows then walls
        if (valText.match(/^\d+$/)) {
          if (valText.length > 1 && vb.height > 0.025) {
            const digits = valText.split("");
            if (!data["#_of_windows"]) data["#_of_windows"] = digits[0];
            if (!data["#_of_exterior_walls"])
              data["#_of_exterior_walls"] = digits[1];
          } else {
            if (!data["#_of_windows"]) {
              data["#_of_windows"] = valText;
            } else if (!data["#_of_exterior_walls"]) {
              data["#_of_exterior_walls"] = valText;
            }
          }
        }
      }
    }
  }

  // Outdoor unit notes
  for (const block of rightBlocks) {
    if (block.text.match(/^For bedroom/i)) {
      data["note"] = block.text;
    }
  }

  return data;
}

function parseNum(str) {
  if (typeof str !== "string") return str;
  const n = parseFloat(str.replace(/,/g, ""));
  return isNaN(n) ? str : n;
}

function normalizeData(data) {
  const out = { ...data };

  // "12,011 Btuh" → 12011
  for (const key of ["heat", "cool"]) {
    if (out[key]) out[key] = parseNum(out[key].replace(/\s*btuh/i, ""));
  }

  // "15K BTUh" → 15000
  if (out.capacity) {
    const m = out.capacity.match(/([\d.]+)(K?)\s*BTUh/i);
    if (m) out.capacity = parseFloat(m[1]) * (m[2].toUpperCase() === "K" ? 1000 : 1);
  }

  // "9.1 ft" → 9.1, "206 sq ft" → 206, "1,872 cu ft" → 1872
  if (out.height) out.height = parseNum(out.height);
  if (out.floor_area) out.floor_area = parseNum(out.floor_area);
  if (out.volume) out.volume = parseNum(out.volume);

  // Already numeric strings
  for (const key of [
    "latent_cooling", "sensible_cooling", "sensible_ratio_(shr)",
    "cfm_heating", "cfm_cooling", "#_of_windows", "#_of_exterior_walls",
  ]) {
    if (out[key] !== undefined) out[key] = parseNum(out[key]);
  }

  return out;
}

async function uploadPageImage(pngBuffer, pageNum, folderId, driveAuth) {
  const metadata = await sharp(pngBuffer).metadata();
  const cropWidth = Math.floor(metadata.width * 0.713);
  const croppedBuffer = await sharp(pngBuffer)
    .extract({ left: 0, top: 0, width: cropWidth, height: metadata.height })
    .png()
    .toBuffer();

  const { Readable } = require("stream");
  const drive = google.drive({ version: "v3", auth: driveAuth });

  const file = await drive.files.create({
    supportsAllDrives: true,
    requestBody: {
      name: `proposal_page_${pageNum}.png`,
      parents: folderId ? [folderId] : [],
    },
    media: {
      mimeType: "image/png",
      body: Readable.from(croppedBuffer),
    },
    fields: "id",
  });

  const fileId = file.data.id;

  // Make the file publicly readable so the URL works without auth
  await drive.permissions.create({
    fileId,
    supportsAllDrives: true,
    requestBody: { role: "reader", type: "anyone" },
  });

  return `https://drive.google.com/file/d/${fileId}/view`;
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "proposal-ocr-api" });
});

// Main OCR endpoint
app.post("/ocr/design", async (req, res) => {
  try {
    const { pdf_url, api_key, google_drive_folder_id } = req.body;

    if (!pdf_url) {
      return res.status(400).json({ error: "pdf_url is required" });
    }
    if (!api_key) {
      return res.status(400).json({ error: "api_key is required" });
    }

    // Normalize URL
    let fileUrl = pdf_url;
    if (fileUrl.startsWith("//")) fileUrl = "https:" + fileUrl;
    else if (!fileUrl.startsWith("http")) fileUrl = "https:" + fileUrl;

    // Fetch PDF
    const fileResponse = await fetch(fileUrl);
    if (!fileResponse.ok) {
      return res
        .status(400)
        .json({ error: `Failed to fetch PDF: ${fileResponse.status}` });
    }
    const fileBuffer = await fileResponse.arrayBuffer();
    const pdfBuffer = Buffer.from(fileBuffer);
    const base64File = pdfBuffer.toString("base64");

    // Run first Vision batch and PDF image conversion in parallel
    const [firstResult, pdfImages] = await Promise.all([
      callVision(base64File, [1, 2, 3, 4, 5], api_key),
      pdfImgConvert.convert(pdfBuffer, { base64: false, width: 1400 }),
    ]);

    if (firstResult.error) {
      return res.status(500).json({ error: firstResult.error.message });
    }

    let allResponses =
      firstResult.responses &&
      firstResult.responses[0] &&
      firstResult.responses[0].responses;

    if (!allResponses) {
      return res.status(500).json({ error: "No page responses from Vision API" });
    }

    const totalPages = firstResult.responses[0].totalPages || allResponses.length;

    // Fetch remaining Vision pages in parallel
    if (totalPages > 5) {
      const batchPromises = [];
      for (let startPage = 6; startPage <= totalPages; startPage += 5) {
        const pageNums = [];
        for (let p = startPage; p < startPage + 5 && p <= totalPages; p++) {
          pageNums.push(p);
        }
        batchPromises.push(callVision(base64File, pageNums, api_key));
      }

      const batchResults = await Promise.all(batchPromises);

      for (const batchResult of batchResults) {
        if (batchResult.error) continue;
        const batchPages =
          batchResult.responses &&
          batchResult.responses[0] &&
          batchResult.responses[0].responses;
        if (batchPages) allResponses = allResponses.concat(batchPages);
      }
    }

    // Parse page 1 (title page)
    const info = parsePage1(allResponses[0]);

    // Upload images for pages 2+ in parallel
    const driveAuth = getDriveAuth();
    const imageUploadPromises = [];
    for (let i = 1; i < allResponses.length; i++) {
      const pageNum = i + 1;
      const imgBuffer = pdfImages[i] ? Buffer.from(pdfImages[i]) : null;
      imageUploadPromises.push(
        imgBuffer
          ? uploadPageImage(imgBuffer, pageNum, google_drive_folder_id, driveAuth).catch(() => null)
          : Promise.resolve(null)
      );
    }
    const imageUrls = await Promise.all(imageUploadPromises);

    // Build pages array
    const pages = [];
    for (let i = 1; i < allResponses.length; i++) {
      pages.push({
        page: i + 1,
        data: normalizeData(parseContentPage(allResponses[i])),
        image_url: imageUrls[i - 1],
      });
    }

    return res.json({
      title: info.title,
      address: info.address,
      created_on: info.created_on,
      total_pages: allResponses.length,
      pages: pages,
    });
  } catch (err) {
    console.error("OCR Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// Debug endpoint — returns raw block positions for template debugging
app.post("/ocr/debug", async (req, res) => {
  try {
    const { pdf_url, api_key, page_number } = req.body;

    if (!pdf_url) return res.status(400).json({ error: "pdf_url is required" });
    if (!api_key) return res.status(400).json({ error: "api_key is required" });

    let fileUrl = pdf_url;
    if (fileUrl.startsWith("//")) fileUrl = "https:" + fileUrl;
    else if (!fileUrl.startsWith("http")) fileUrl = "https:" + fileUrl;

    const fileResponse = await fetch(fileUrl);
    if (!fileResponse.ok) {
      return res
        .status(400)
        .json({ error: `Failed to fetch PDF: ${fileResponse.status}` });
    }
    const fileBuffer = await fileResponse.arrayBuffer();
    const base64File = Buffer.from(fileBuffer).toString("base64");

    // If specific page requested, only fetch that page
    const pageNums = page_number ? [page_number] : [1, 2, 3, 4, 5];
    const result = await callVision(base64File, pageNums, api_key);

    if (result.error) {
      return res.status(500).json({ error: result.error.message });
    }

    const responses =
      result.responses &&
      result.responses[0] &&
      result.responses[0].responses;

    if (!responses) {
      return res.status(500).json({ error: "No page responses" });
    }

    const RIGHT_COL_START = 0.7;
    const debugPages = [];

    for (let i = 0; i < responses.length; i++) {
      const pageResponse = responses[i];
      const pageNum = page_number ? page_number : i + 1;

      if (
        !pageResponse ||
        !pageResponse.fullTextAnnotation ||
        !pageResponse.fullTextAnnotation.pages ||
        !pageResponse.fullTextAnnotation.pages[0]
      ) {
        debugPages.push({ page: pageNum, blocks: [], summary: "No data" });
        continue;
      }

      const pageObj = pageResponse.fullTextAnnotation.pages[0];
      const rawText = pageResponse.fullTextAnnotation.text || "";
      const allBlocks = [];

      if (pageObj.blocks) {
        for (const block of pageObj.blocks) {
          const pos = getBlockPos(block);
          const text = getBlockText(block);
          const isRight = pos && pos.x >= RIGHT_COL_START;

          // Word-level detail
          const words = [];
          if (block.paragraphs) {
            for (const para of block.paragraphs) {
              if (!para.words) continue;
              for (const word of para.words) {
                if (!word.symbols) continue;
                let wordText = "";
                for (const sym of word.symbols) wordText += sym.text || "";

                let wordPos = null;
                if (word.boundingBox && word.boundingBox.normalizedVertices) {
                  const wv = word.boundingBox.normalizedVertices;
                  wordPos = {
                    topLeft: {
                      x: ((wv[0] && wv[0].x) || 0).toFixed(3),
                      y: ((wv[0] && wv[0].y) || 0).toFixed(3),
                    },
                    bottomRight: {
                      x: ((wv[2] && wv[2].x) || 0).toFixed(3),
                      y: ((wv[2] && wv[2].y) || 0).toFixed(3),
                    },
                  };
                }
                words.push({ text: wordText, pos: wordPos });
              }
            }
          }

          allBlocks.push({
            text: text,
            type: block.blockType || "unknown",
            is_right_column: isRight,
            x: pos ? pos.x.toFixed(3) : null,
            y_top: pos ? pos.y.toFixed(3) : null,
            y_bottom: pos ? pos.yBottom.toFixed(3) : null,
            height: pos ? pos.height.toFixed(4) : null,
            midY: pos ? ((pos.y + pos.yBottom) / 2).toFixed(4) : null,
            words: words,
          });
        }
      }

      const rightColBlocks = allBlocks
        .filter((b) => b.is_right_column)
        .sort((a, b) => parseFloat(a.midY) - parseFloat(b.midY));

      debugPages.push({
        page: pageNum,
        page_dimensions: { width: pageObj.width, height: pageObj.height },
        raw_text: rawText,
        total_blocks: allBlocks.length,
        right_col_blocks: rightColBlocks.length,
        right_col_threshold: RIGHT_COL_START,
        right_column: rightColBlocks.map((b) => ({
          text: b.text,
          x: b.x,
          y_top: b.y_top,
          y_bottom: b.y_bottom,
          midY: b.midY,
          height: b.height,
        })),
        all_blocks: allBlocks,
      });
    }

    return res.json({
      total_pages: result.responses[0].totalPages || responses.length,
      pages: debugPages,
    });
  } catch (err) {
    console.error("Debug OCR Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// Manual J endpoint — extracts whole-house heat and cool from page 1
app.post("/ocr/manualj", async (req, res) => {
  try {
    const { pdf_url, api_key } = req.body;

    if (!pdf_url) return res.status(400).json({ error: "pdf_url is required" });
    if (!api_key) return res.status(400).json({ error: "api_key is required" });

    let fileUrl = pdf_url;
    if (fileUrl.startsWith("//")) fileUrl = "https:" + fileUrl;
    else if (!fileUrl.startsWith("http")) fileUrl = "https:" + fileUrl;

    const fileResponse = await fetch(fileUrl);
    if (!fileResponse.ok) {
      return res.status(400).json({ error: `Failed to fetch PDF: ${fileResponse.status}` });
    }
    const fileBuffer = await fileResponse.arrayBuffer();
    const base64File = Buffer.from(fileBuffer).toString("base64");

    const result = await callVision(base64File, [1], api_key);
    if (result.error) return res.status(500).json({ error: result.error.message });

    const pageResponse = result.responses?.[0]?.responses?.[0];
    if (!pageResponse?.fullTextAnnotation) {
      return res.status(500).json({ error: "No text found on page 1" });
    }

    const text = pageResponse.fullTextAnnotation.text || "";

    const heatMatch = text.match(/Heat:\s*([\d,]+)\s*Btuh/i);
    const coolMatch = text.match(/Cool:\s*([\d,]+)\s*Btuh/i);

    return res.json({
      heat: heatMatch ? parseNum(heatMatch[1]) : null,
      cool: coolMatch ? parseNum(coolMatch[1]) : null,
    });
  } catch (err) {
    console.error("Manual J OCR Error:", err);
    return res.status(500).json({ error: err.message });
  }
});

// ─── Start ──────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Proposal OCR API running on port ${PORT}`);
});
