const form = document.getElementById("novel-form");
const submitButton = document.getElementById("submit-button");
const statusPill = document.getElementById("status-pill");
const statusText = document.getElementById("status-text");
const storyBox = document.getElementById("story-box");
const stepsBox = document.getElementById("steps-box");
const promptsBox = document.getElementById("prompts-box");
const testConnectionButton = document.getElementById("test-connection-button");
const connectionStatus = document.getElementById("connection-status");
const connectionPanel = document.getElementById("connection-panel");
const connectionDetail = document.getElementById("connection-detail");
const historyBox = document.getElementById("history-box");
const refreshHistoryButton = document.getElementById("refresh-history-button");
const fontSelect = document.getElementById("font-select");
const readingModeSelect = document.getElementById("reading-mode-select");
const exportHtmlButton = document.getElementById("export-html-button");
const exportPdfButton = document.getElementById("export-pdf-button");
const exportMdButton = document.getElementById("export-md-button");
const exportTxtButton = document.getElementById("export-txt-button");
const tabs = document.querySelectorAll(".tab");
const panels = document.querySelectorAll(".tab-panel");

if (!form) {
  throw new Error("Missing form #novel-form");
}

const fields = {
  apiKey: form.elements.namedItem("apiKey"),
  baseUrl: form.elements.namedItem("baseUrl"),
  model: form.elements.namedItem("model"),
  style: form.elements.namedItem("style"),
  generationMode: form.elements.namedItem("generationMode"),
  audience: form.elements.namedItem("audience"),
  protagonist: form.elements.namedItem("protagonist"),
  premise: form.elements.namedItem("premise"),
  hook: form.elements.namedItem("hook"),
  length: form.elements.namedItem("length")
};

const lengthInput = fields.length;
const lengthValue = document.getElementById("length-value");
const query = new URLSearchParams(window.location.search);

let activeRunId = null;
let activeEventSource = null;
let latestRun = null;

const readingFonts = {
  song: '"STSong", "SimSun", serif',
  hei: '"Microsoft YaHei", "SimHei", sans-serif',
  round: '"YouYuan", "Arial Rounded MT Bold", sans-serif',
  kai: '"KaiTi", "STKaiti", serif'
};

if (query.get("mobile") === "1") {
  document.documentElement.classList.add("mobile-entry");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function setStatus(pill, text) {
  if (statusPill) statusPill.textContent = pill;
  if (statusText) statusText.textContent = text;
}

function setConnectionState(kind, summary, detail) {
  if (!connectionPanel || !connectionStatus || !connectionDetail) return;
  connectionPanel.classList.remove("is-idle", "is-loading", "is-success", "is-error");
  connectionPanel.classList.add(kind);
  connectionStatus.textContent = summary;
  connectionDetail.textContent = detail;
}

function renderInlineMarkdown(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>");
}

function markdownToHtml(markdown) {
  if (!markdown) return "<p class='empty'>正文会显示在这里。</p>";

  const lines = String(markdown).replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  let listItems = [];

  function flushParagraph() {
    if (!paragraph.length) return;
    blocks.push(`<p>${renderInlineMarkdown(paragraph.join("<br>"))}</p>`);
    paragraph = [];
  }

  function flushList() {
    if (!listItems.length) return;
    blocks.push(`<ul>${listItems.map(item => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ul>`);
    listItems = [];
  }

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }

    if (/^#{1,3}\s+/.test(line)) {
      flushParagraph();
      flushList();
      const level = line.match(/^#+/)[0].length;
      const text = line.replace(/^#{1,3}\s+/, "");
      blocks.push(`<h${level}>${renderInlineMarkdown(text)}</h${level}>`);
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      flushParagraph();
      listItems.push(line.replace(/^[-*]\s+/, ""));
      continue;
    }

    if (/^>\s?/.test(line)) {
      flushParagraph();
      flushList();
      blocks.push(`<blockquote>${renderInlineMarkdown(line.replace(/^>\s?/, ""))}</blockquote>`);
      continue;
    }

    if (/^---+$/.test(line)) {
      flushParagraph();
      flushList();
      blocks.push("<hr>");
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return blocks.join("");
}

function renderStory(markdown) {
  if (!storyBox) return;
  storyBox.innerHTML = markdown
    ? `<article class="story-doc">${markdownToHtml(markdown)}</article>`
    : "<p class='empty'>正文会显示在这里。</p>";
}

function renderSteps(steps) {
  if (!stepsBox) return;
  if (!steps || !steps.length) {
    stepsBox.innerHTML = "<p class='empty'>还没有阶段结果。</p>";
    return;
  }

  stepsBox.innerHTML = steps.map(step => {
    const parsed = step.output?.parsed ? JSON.stringify(step.output.parsed, null, 2) : "";
    const raw = step.output?.raw || "";
    return `
      <article class="step-card">
        <header class="step-head">
          <div>
            <h3>${escapeHtml(step.title || "阶段")}</h3>
            <p>${escapeHtml(step.status || "pending")}</p>
          </div>
          <span>${step.durationMs ? `${Math.round(step.durationMs / 100) / 10}s` : "--"}</span>
        </header>
        <p class="step-summary">${escapeHtml(step.summary || step.error || "等待执行。")}</p>
        ${parsed ? `<details><summary>结构化结果</summary><pre>${escapeHtml(parsed)}</pre></details>` : ""}
        ${raw ? `<details><summary>原始输出</summary><pre>${escapeHtml(raw)}</pre></details>` : ""}
      </article>
    `;
  }).join("");
}

function renderPrompts(steps) {
  if (!promptsBox) return;
  if (!steps || !steps.length) {
    promptsBox.innerHTML = "<p class='empty'>生成后这里会显示每一步提示词。</p>";
    return;
  }

  promptsBox.innerHTML = steps.map(step => `
    <article class="prompt-card">
      <header class="step-head">
        <div>
          <h3>${escapeHtml(step.title || "阶段")}</h3>
          <p>${escapeHtml(step.status || "pending")}</p>
        </div>
      </header>
      <details ${step.prompt?.system ? "open" : ""}>
        <summary>System</summary>
        <pre>${escapeHtml(step.prompt?.system || "")}</pre>
      </details>
      <details>
        <summary>Developer</summary>
        <pre>${escapeHtml(step.prompt?.developer || "")}</pre>
      </details>
      <details>
        <summary>User</summary>
        <pre>${escapeHtml(step.prompt?.user || "")}</pre>
      </details>
    </article>
  `).join("");
}

async function parseJsonResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    return { error: text || "Invalid JSON response." };
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const data = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}

function updateRunView(run) {
  latestRun = run;
  const statusMap = {
    queued: ["排队中", "任务已创建，等待开始。"],
    running: [
      "生成中",
      `当前步骤：${run.currentStep || "初始化"}，模式：${run.generationMode === "balanced" ? "标准" : "快速"}`
    ],
    completed: ["完成", "全部阶段已完成。"],
    failed: ["失败", run.error || "生成失败。"]
  };
  const [pill, text] = statusMap[run.status] || ["未知", "未知状态。"];
  setStatus(pill, text);
  renderStory(run.finalMarkdown);
  renderSteps(run.steps);
  renderPrompts(run.steps);
  renderHistory();
}

async function fetchRun(runId) {
  return fetchJson(`/api/runs/${runId}`);
}

async function fetchHistory() {
  const data = await fetchJson("/api/runs");
  return data.runs || [];
}

async function deleteRun(runId) {
  return fetchJson(`/api/runs/${runId}`, { method: "DELETE" });
}

async function renderHistory() {
  if (!historyBox) return;
  try {
    const runs = await fetchHistory();
    if (!runs.length) {
      historyBox.innerHTML = "<p class='empty'>还没有历史任务。</p>";
      return;
    }
    historyBox.innerHTML = runs.map(run => `
      <article class="history-card">
        <div class="history-main">
          <header class="step-head">
            <div>
              <h3>${escapeHtml(run.style || "未命名任务")}</h3>
              <p>${escapeHtml(run.status || "unknown")}</p>
            </div>
            <span>${run.createdAt ? new Date(run.createdAt).toLocaleString() : "--"}</span>
          </header>
          <p class="step-summary">${escapeHtml(run.premise || "")}</p>
        </div>
        <div class="history-actions">
          <button type="button" class="ghost-button" data-load-run="${escapeHtml(run.id)}">打开结果</button>
          ${run.hasFinal ? `<button type="button" class="ghost-button" data-download-run="${escapeHtml(run.id)}">导出文本</button>` : ""}
          ${run.status === "completed" || run.status === "failed"
            ? `<button type="button" class="ghost-button danger-button" data-delete-run="${escapeHtml(run.id)}">删除记录</button>`
            : ""}
        </div>
      </article>
    `).join("");
  } catch (error) {
    historyBox.innerHTML = `<p class='empty'>${escapeHtml(error.message)}</p>`;
  }
}

function connectEvents(runId) {
  if (activeEventSource) activeEventSource.close();
  activeEventSource = new EventSource(`/api/runs/${runId}/events`);

  const refresh = async () => {
    try {
      const run = await fetchRun(runId);
      updateRunView(run);
      if (run.status === "completed" || run.status === "failed") {
        activeEventSource?.close();
      }
    } catch (error) {
      setStatus("失败", error.message);
    }
  };

  ["snapshot", "run.started", "step.started", "step.completed", "run.completed", "run.failed"]
    .forEach(eventName => activeEventSource.addEventListener(eventName, refresh));

  activeEventSource.onerror = () => {
    refresh();
  };
}

function ensureExportableContent() {
  if (!latestRun?.finalMarkdown) {
    setStatus("失败", "当前没有可导出正文。");
    return null;
  }
  return latestRun.finalMarkdown;
}

function downloadBlob(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function buildExportBaseName() {
  const runId = latestRun?.id || "story";
  return runId.replace(/[^a-zA-Z0-9-_]/g, "-");
}

function buildExportHtml(title, bodyHtml) {
  const fallback = '"STSong", "SimSun", serif';
  const cnFont = getComputedStyle(document.documentElement)
    .getPropertyValue("--reader-cn-font")
    .trim() || fallback;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin: 0; background: #f5efe6; color: #2b241d; font-family: "Times New Roman", ${cnFont}, serif; }
    .page { width: min(880px, calc(100vw - 48px)); margin: 32px auto; padding: 56px 72px; background: #fffdf8; box-shadow: 0 18px 48px rgba(0,0,0,0.08); }
    h1,h2,h3 { line-height: 1.35; }
    p { margin: 0 0 18px; line-height: 2; text-indent: 2em; font-size: 18px; }
    ul { margin: 0 0 18px 1.6em; } li { margin-bottom: 10px; line-height: 1.9; font-size: 18px; }
    blockquote { margin: 0 0 18px; padding: 10px 16px; border-left: 4px solid rgba(155,58,43,.25); background: rgba(155,58,43,.05); }
    hr { border: 0; border-top: 1px solid rgba(155,58,43,.16); margin: 24px 0; }
    code { padding: 2px 6px; border-radius: 6px; background: rgba(155,58,43,.08); }
    @media print { body { background: #fff; } .page { width: auto; margin: 0; padding: 0; box-shadow: none; } }
  </style>
</head>
<body>
  <article class="page">${bodyHtml}</article>
</body>
</html>`;
}

if (lengthInput && lengthValue) {
  lengthInput.addEventListener("input", () => {
    lengthValue.textContent = `${lengthInput.value} 字`;
  });
}

if (fontSelect) {
  fontSelect.addEventListener("change", () => {
    const stack = readingFonts[fontSelect.value] || readingFonts.song;
    document.documentElement.style.setProperty("--reader-cn-font", stack);
  });
}

if (readingModeSelect) {
  readingModeSelect.addEventListener("change", () => {
    document.documentElement.classList.toggle("word-mode", readingModeSelect.value === "word");
  });
}

tabs.forEach(tab => {
  tab.addEventListener("click", () => {
    tabs.forEach(item => item.classList.toggle("is-active", item === tab));
    panels.forEach(panel => panel.classList.toggle("is-active", panel.dataset.panel === tab.dataset.tab));
  });
});

if (testConnectionButton) {
  testConnectionButton.addEventListener("click", async () => {
    const payload = {
      apiKey: fields.apiKey?.value || "",
      baseUrl: fields.baseUrl?.value || "",
      model: fields.model?.value || ""
    };

    testConnectionButton.disabled = true;
    setConnectionState("is-loading", "测试中...", "正在发送最小连接请求。");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    try {
      const data = await fetchJson("/api/validate-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(payload)
      });
      setConnectionState("is-success", "连接成功", data.message || "模型已响应。");
    } catch (error) {
      const msg = error.name === "AbortError" ? "连接超时，请检查网络或 Base URL。" : error.message;
      setConnectionState("is-error", "连接失败", msg);
    } finally {
      clearTimeout(timer);
      testConnectionButton.disabled = false;
    }
  });
}

if (refreshHistoryButton) {
  refreshHistoryButton.addEventListener("click", () => {
    renderHistory();
  });
}

if (historyBox) {
  historyBox.addEventListener("click", async event => {
    const loadButton = event.target.closest("[data-load-run]");
    const downloadButton = event.target.closest("[data-download-run]");
    const deleteButton = event.target.closest("[data-delete-run]");

    if (loadButton) {
      const runId = loadButton.dataset.loadRun;
      try {
        const run = await fetchRun(runId);
        activeRunId = runId;
        updateRunView(run);
        if (tabs[0]) tabs[0].click();
      } catch (error) {
        setStatus("失败", error.message);
      }
      return;
    }

    if (downloadButton) {
      const runId = downloadButton.dataset.downloadRun;
      try {
        const run = latestRun?.id === runId ? latestRun : await fetchRun(runId);
        downloadBlob(`${runId}.txt`, run.finalMarkdown || "", "text/plain;charset=utf-8");
      } catch (error) {
        setStatus("失败", error.message);
      }
      return;
    }

    if (deleteButton) {
      const runId = deleteButton.dataset.deleteRun;
      const confirmed = window.confirm("确认删除这条历史记录吗？删除后无法恢复。");
      if (!confirmed) return;
      try {
        await deleteRun(runId);
        if (latestRun?.id === runId) {
          latestRun = null;
          activeRunId = null;
          renderStory("");
          renderSteps([]);
          renderPrompts([]);
          setStatus("待开始", "当前历史记录已删除。");
        }
        renderHistory();
      } catch (error) {
        setStatus("失败", error.message);
      }
    }
  });
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  const payload = {
    apiKey: fields.apiKey?.value || "",
    baseUrl: fields.baseUrl?.value || "",
    model: fields.model?.value || "",
    style: fields.style?.value || "",
    generationMode: fields.generationMode?.value || "fast",
    audience: fields.audience?.value || "",
    protagonist: fields.protagonist?.value || "",
    premise: fields.premise?.value || "",
    hook: fields.hook?.value || "",
    length: fields.length?.value || "1200"
  };

  submitButton.disabled = true;
  activeRunId = null;
  setStatus("提交中", "正在创建任务。");
  renderStory("");
  renderSteps([]);
  renderPrompts([]);

  try {
    const data = await fetchJson("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    activeRunId = data.runId;
    setStatus("排队中", `任务已创建：${activeRunId}`);
    connectEvents(activeRunId);
  } catch (error) {
    setStatus("失败", error.message);
    if (storyBox) storyBox.innerHTML = `<pre>${escapeHtml(error.message)}</pre>`;
  } finally {
    submitButton.disabled = false;
  }
});

if (exportTxtButton) {
  exportTxtButton.addEventListener("click", () => {
    const markdown = ensureExportableContent();
    if (!markdown) return;
    downloadBlob(`${buildExportBaseName()}.txt`, markdown, "text/plain;charset=utf-8");
  });
}

if (exportMdButton) {
  exportMdButton.addEventListener("click", () => {
    const markdown = ensureExportableContent();
    if (!markdown) return;
    downloadBlob(`${buildExportBaseName()}.md`, markdown, "text/markdown;charset=utf-8");
  });
}

if (exportHtmlButton) {
  exportHtmlButton.addEventListener("click", () => {
    const markdown = ensureExportableContent();
    if (!markdown) return;
    const bodyHtml = `<article class="story-doc">${markdownToHtml(markdown)}</article>`;
    const html = buildExportHtml(buildExportBaseName(), bodyHtml);
    downloadBlob(`${buildExportBaseName()}.html`, html, "text/html;charset=utf-8");
  });
}

if (exportPdfButton) {
  exportPdfButton.addEventListener("click", () => {
    const markdown = ensureExportableContent();
    if (!markdown) return;
    const bodyHtml = `<article class="story-doc">${markdownToHtml(markdown)}</article>`;
    const html = buildExportHtml(buildExportBaseName(), bodyHtml);
    const win = window.open("", "_blank", "noopener,noreferrer");
    if (!win) {
      setStatus("失败", "浏览器拦截了打印窗口，请允许弹窗后重试。");
      return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 250);
  });
}

renderHistory();
document.documentElement.style.setProperty("--reader-cn-font", readingFonts.song);
document.documentElement.classList.toggle("word-mode", false);
setConnectionState("is-idle", "尚未测试", "点击“测试连接”检查 API 是否连通。");
