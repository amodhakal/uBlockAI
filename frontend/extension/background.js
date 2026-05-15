chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "ANALYZE_IMAGES") {
    analyzeImages(msg.payload)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true; // IMPORTANT: keep the message channel open for async
  }
  if (msg?.type === "UPLOAD_REPORTS") {
    uploadReports(msg.reports)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
});

async function analyzeImages(payload) {
  console.log("=== SENDING FETCH REQUEST ===");
  console.log("URL:", "https://hack-ncstate-2026.onrender.com/api/analyze_claims");
  console.log("Payload:", payload);
  console.log("============================");
  
  const resp = await fetch("https://hack-ncstate-2026.onrender.com/api/analyze_claims", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Backend ${resp.status}: ${text}`);
  }
  return await resp.json();
}

async function uploadReports(reports) {
  if (!reports || reports.length === 0) return { uploaded: 0 };
  const resp = await fetch("https://hack-ncstate-2026.onrender.com/api/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reports }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Feedback API ${resp.status}: ${text}`);
  }
  return await resp.json();
}

// Periodically upload stored false positive reports
chrome.alarms?.create("uploadReports", { periodInMinutes: 15 });
chrome.alarms?.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "uploadReports") {
    chrome.storage.local.get(["falsePositiveReports"], async (data) => {
      const reports = data.falsePositiveReports || [];
      if (reports.length === 0) return;
      try {
        await uploadReports(reports);
        // Clear uploaded reports
        chrome.storage.local.set({ falsePositiveReports: [] });
        console.log(`[AIBot] Uploaded ${reports.length} false positive reports`);
      } catch (err) {
        console.error("[AIBot] Failed to upload reports:", err);
      }
    });
  }
});
