const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 3210);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const RUNS_DIR = path.join(ROOT, "runs");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8"
};

const runStore = new Map();
const eventStreams = new Map();

fs.mkdirSync(RUNS_DIR, { recursive: true });

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function getAccessInfo() {
  const interfaces = os.networkInterfaces();
  const lanUrls = [];

  for (const entries of Object.values(interfaces)) {
    for (const item of entries || []) {
      if (item.family === "IPv4" && !item.internal) {
        lanUrls.push(`http://${item.address}:${PORT}`);
      }
    }
  }

  return {
    localUrl: `http://127.0.0.1:${PORT}`,
    lanUrls: [...new Set(lanUrls)]
  };
}

function sendFile(res, filePath) {
  const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendJson(res, 404, { error: "File not found." });
      return;
    }
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-store"
    });
    res.end(data);
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1024 * 1024 * 2) {
        reject(new Error("Request body too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error("Invalid JSON body."));
      }
    });
    req.on("error", reject);
  });
}

function ensureText(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function clampLength(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1200;
  return Math.max(600, Math.min(6000, Math.round(number)));
}

function normalizeMode(value) {
  return value === "balanced" ? "balanced" : "fast";
}

function normalizeGenre(style) {
  const styles = {
    suspense: "悬疑",
    fantasy: "玄幻",
    romance: "言情"
  };
  return styles[style] || "悬疑";
}

function normalizeBaseUrl(value) {
  const raw = ensureText(value, "https://api.openai.com/v1");
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function summarizeParsed(parsed) {
  if (!parsed || typeof parsed !== "object") return "";
  if (Array.isArray(parsed.characters)) {
    return parsed.characters.map(character => `${character.name}：${character.arc}`).join("\n");
  }
  if (Array.isArray(parsed.scenes)) {
    return parsed.scenes.map(scene => `${scene.title}：${scene.purpose}`).join("\n");
  }
  if (Array.isArray(parsed.acts)) {
    return parsed.acts.map(act => `${act.label || act.id}：${act.summary || act.goal || ""}`).join("\n");
  }
  return Object.entries(parsed)
    .slice(0, 8)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("\n");
}

function extractAssistantText(data) {
  const choice = data?.choices?.[0];
  if (!choice) return "";
  const message = choice.message;
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map(part => {
        if (typeof part === "string") return part;
        if (typeof part?.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  return "";
}

function extractJson(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("Model output did not contain JSON.");
  }
  return JSON.parse(match[0]);
}

function createRunSnapshot(run) {
  return {
    id: run.id,
    status: run.status,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    error: run.error,
    input: run.input,
    model: run.model,
    baseUrl: run.baseUrl,
    generationMode: run.generationMode,
    usage: run.usage,
    currentStep: run.currentStep,
    steps: run.steps,
    finalMarkdown: run.finalMarkdown,
    latestSummary: run.latestSummary
  };
}

function saveRun(run) {
  const runDir = path.join(RUNS_DIR, run.id);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "run.json"),
    JSON.stringify(createRunSnapshot(run), null, 2),
    "utf8"
  );
  if (run.finalMarkdown) {
    fs.writeFileSync(path.join(runDir, "final.md"), run.finalMarkdown, "utf8");
    fs.writeFileSync(path.join(runDir, "final.txt"), run.finalMarkdown, "utf8");
  }
}

function deleteRunArtifacts(runId) {
  const runDir = path.join(RUNS_DIR, runId);
  if (fs.existsSync(runDir)) {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}

function pushEvent(runId, type, payload) {
  const clients = eventStreams.get(runId) || [];
  const eventBody = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) {
    res.write(eventBody);
  }
}

async function callChatCompletion({ apiKey, baseUrl, model, messages, temperature, maxTokens }) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens
    })
  });

  const text = await response.text();
  let json;

  try {
    json = text ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`Upstream did not return JSON.\n${text}`);
  }

  if (!response.ok) {
    const detail = json?.error?.message || text || response.statusText;
    throw new Error(`Upstream API error (${response.status}): ${detail}`);
  }

  return {
    text: extractAssistantText(json),
    usage: json?.usage || {}
  };
}

async function validateApiConfig({ apiKey, baseUrl, model }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: "Reply with exactly: ok"
          }
        ],
        temperature: 0,
        max_tokens: 8
      })
    });

    const text = await response.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch (error) {
      json = {};
    }

    if (!response.ok) {
      const detail = json?.error?.message || text || response.statusText;
      throw new Error(`测试失败 (${response.status}): ${detail}`);
    }

    const output = extractAssistantText(json).trim();
    return {
      ok: true,
      message: output ? `连接成功，模型已响应：${output}` : "连接成功。"
    };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("连接超时，请检查 Base URL、网络或网关响应速度。");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function buildStructureMessages(input) {
  const system = [
    "你是中文短篇小说策划助手。",
    "你的任务是生成可执行、可续写的结构化创作材料。",
    "严格遵守输入约束，不新增用户未允许的世界观设定。",
    "先输出 JSON，再给 5 条以内简短说明。"
  ].join("\n");

  const developer = [
    "当前阶段：结构设计。",
    "必须输出字段：theme, tone, narrative_pov, core_conflict, opening_hook, acts, ending_type, must_keep。",
    "acts 必须包含 opening, development, climax, resolution 四段。",
    "不得生成正文段落，不得写大段对话。"
  ].join("\n");

  const user = JSON.stringify(
    {
      style: input.style,
      protagonist: input.protagonist,
      premise: input.premise,
      hook: input.hook,
      length: input.length,
      audience: input.audience
    },
    null,
    2
  );

  return { system, developer, user };
}

function buildCharactersMessages(input, structure) {
  const system = [
    "你是中文短篇小说人物设计助手。",
    "你需要基于既有结构补全人物动机、秘密、关系和人物弧线。",
    "保持人物可信，不要脸谱化。",
    "先输出 JSON，再给简短说明。"
  ].join("\n");

  const developer = [
    "当前阶段：人物设计。",
    "不能推翻结构设定。",
    "必须输出 characters 数组，至少 3 个角色。",
    "每个人必须有 name, role, public_face, true_motive, fear, secret, relationship_net, arc, voice_style。"
  ].join("\n");

  const user = [
    "原始输入：",
    JSON.stringify(
      {
        style: input.style,
        protagonist: input.protagonist,
        premise: input.premise,
        hook: input.hook,
        length: input.length
      },
      null,
      2
    ),
    "",
    "结构设计：",
    JSON.stringify(structure, null, 2)
  ].join("\n");

  return { system, developer, user };
}

function buildBlueprintMessages(input) {
  const system = [
    "你是中文短篇小说快写助手。",
    "你的任务是在一步内产出可直接用于写正文的创作蓝图。",
    "先输出 JSON，再给 3 条以内简短说明。"
  ].join("\n");

  const developer = [
    "当前阶段：快速蓝图。",
    "必须同时输出结构、人物和场景信息。",
    "JSON 须包含 theme, tone, narrative_pov, core_conflict, acts, characters, scenes, must_keep。",
    "characters 至少 3 个，scenes 控制在 4 到 6 个。"
  ].join("\n");

  const user = JSON.stringify(
    {
      style: input.style,
      audience: input.audience,
      protagonist: input.protagonist,
      premise: input.premise,
      hook: input.hook,
      length: input.length,
      target: "以更短等待时间完成可用短篇"
    },
    null,
    2
  );

  return { system, developer, user };
}

function buildScenesMessages(input, structure, characters) {
  const system = [
    "你是中文短篇小说场景设计助手。",
    "你的任务是把结构和人物转换成可直接用于写正文的场景清单。",
    "先输出 JSON，再给简短说明。"
  ].join("\n");

  const developer = [
    "当前阶段：场景设计。",
    "不能推翻结构与人物设定。",
    "必须输出 scenes 数组，每场必须有 id, title, purpose, location, participating_characters, conflict, reveal, emotion_shift, key_image, target_words。",
    "场景数控制在 5 到 8 个，总字数预算接近目标字数。"
  ].join("\n");

  const user = [
    "原始输入：",
    JSON.stringify({ style: input.style, length: input.length, hook: input.hook }, null, 2),
    "",
    "结构设计：",
    JSON.stringify(structure, null, 2),
    "",
    "人物设计：",
    JSON.stringify(characters, null, 2)
  ].join("\n");

  return { system, developer, user };
}

function buildDraftMessages(input, structure, characters, scenes) {
  const system = [
    "你是中文短篇小说写作助手。",
    "你的任务是把结构、人物和场景表整合为完整小说。",
    "保持节奏、画面感与风格一致性。"
  ].join("\n");

  const developer = [
    "当前阶段：正文生成。",
    "输出 Markdown。",
    "先给标题，再给正文。",
    "必须覆盖全部关键场景，但允许自然过渡。",
    "不要再输出 JSON。"
  ].join("\n");

  const user = [
    `风格：${input.style}`,
    `目标字数：${input.length}`,
    input.audience ? `目标读者：${input.audience}` : "",
    "",
    "结构：",
    JSON.stringify(structure, null, 2),
    "",
    "人物：",
    JSON.stringify(characters, null, 2),
    "",
    "场景表：",
    JSON.stringify(scenes, null, 2)
  ]
    .filter(Boolean)
    .join("\n");

  return { system, developer, user };
}

function buildFastDraftMessages(input, blueprint) {
  const system = [
    "你是中文短篇小说写作助手。",
    "你的任务是根据创作蓝图快速写成完整、可读、成稿度高的短篇小说。"
  ].join("\n");

  const developer = [
    "当前阶段：快速正文生成。",
    "输出 Markdown。",
    "先给标题，再给正文。",
    "必须覆盖蓝图中的关键人物与关键场景。",
    "不要输出 JSON，不要解释过程。"
  ].join("\n");

  const user = [
    `风格：${input.style}`,
    `目标字数：${input.length}`,
    input.audience ? `目标读者：${input.audience}` : "",
    "",
    "创作蓝图：",
    JSON.stringify(blueprint, null, 2)
  ]
    .filter(Boolean)
    .join("\n");

  return { system, developer, user };
}

async function runStep({ run, step, apiConfig, messages, expectsJson }) {
  step.status = "running";
  step.startedAt = new Date().toISOString();
  run.currentStep = step.id;
  pushEvent(run.id, "step.started", { stepId: step.id, title: step.title });
  saveRun(run);

  const started = Date.now();
  const result = await callChatCompletion({
    apiKey: apiConfig.apiKey,
    baseUrl: apiConfig.baseUrl,
    model: apiConfig.model,
    messages: [
      { role: "system", content: messages.system },
      { role: "system", content: messages.developer },
      { role: "user", content: messages.user }
    ],
    temperature: step.temperature,
    maxTokens: step.maxTokens
  });

  step.durationMs = Date.now() - started;
  step.prompt = messages;
  step.output.raw = result.text;
  step.usage = {
    inputTokens: result.usage?.prompt_tokens || 0,
    outputTokens: result.usage?.completion_tokens || 0,
    totalTokens: result.usage?.total_tokens || 0
  };
  run.usage.inputTokens += step.usage.inputTokens;
  run.usage.outputTokens += step.usage.outputTokens;
  run.usage.totalTokens += step.usage.totalTokens;

  if (expectsJson) {
    step.output.parsed = extractJson(result.text);
    step.summary = summarizeParsed(step.output.parsed);
  } else {
    step.summary = result.text.slice(0, 400);
  }

  step.status = "completed";
  step.completedAt = new Date().toISOString();
  run.latestSummary = step.summary;
  pushEvent(run.id, "step.completed", {
    stepId: step.id,
    title: step.title,
    summary: step.summary,
    durationMs: step.durationMs
  });
  saveRun(run);
}

async function processRun(run, apiConfig) {
  run.status = "running";
  run.startedAt = new Date().toISOString();
  pushEvent(run.id, "run.started", createRunSnapshot(run));
  saveRun(run);

  try {
    if (run.generationMode === "fast") {
      const blueprintStep = run.steps[0];
      await runStep({
        run,
        step: blueprintStep,
        apiConfig,
        messages: buildBlueprintMessages(run.input),
        expectsJson: true
      });

      const draftStep = run.steps[1];
      await runStep({
        run,
        step: draftStep,
        apiConfig,
        messages: buildFastDraftMessages(run.input, blueprintStep.output.parsed),
        expectsJson: false
      });

      run.finalMarkdown = draftStep.output.raw;
      run.status = "completed";
      run.currentStep = null;
      run.completedAt = new Date().toISOString();
      pushEvent(run.id, "run.completed", createRunSnapshot(run));
      saveRun(run);
      return;
    }

    const structureStep = run.steps[0];
    await runStep({
      run,
      step: structureStep,
      apiConfig,
      messages: buildStructureMessages(run.input),
      expectsJson: true
    });

    const charactersStep = run.steps[1];
    await runStep({
      run,
      step: charactersStep,
      apiConfig,
      messages: buildCharactersMessages(run.input, structureStep.output.parsed),
      expectsJson: true
    });

    const scenesStep = run.steps[2];
    await runStep({
      run,
      step: scenesStep,
      apiConfig,
      messages: buildScenesMessages(
        run.input,
        structureStep.output.parsed,
        charactersStep.output.parsed
      ),
      expectsJson: true
    });

    const draftStep = run.steps[3];
    await runStep({
      run,
      step: draftStep,
      apiConfig,
      messages: buildDraftMessages(
        run.input,
        structureStep.output.parsed,
        charactersStep.output.parsed,
        scenesStep.output.parsed
      ),
      expectsJson: false
    });

    run.finalMarkdown = draftStep.output.raw;
    run.status = "completed";
    run.currentStep = null;
    run.completedAt = new Date().toISOString();
    pushEvent(run.id, "run.completed", createRunSnapshot(run));
    saveRun(run);
  } catch (error) {
    run.status = "failed";
    run.error = error.message || "Unknown error.";
    run.completedAt = new Date().toISOString();
    const runningStep = run.steps.find(step => step.status === "running");
    if (runningStep) {
      runningStep.status = "failed";
      runningStep.error = run.error;
      runningStep.completedAt = new Date().toISOString();
    }
    pushEvent(run.id, "run.failed", createRunSnapshot(run));
    saveRun(run);
  }
}

function createStep(id, title, temperature, maxTokens) {
  return {
    id,
    title,
    status: "pending",
    startedAt: null,
    completedAt: null,
    durationMs: 0,
    temperature,
    maxTokens,
    prompt: {
      system: "",
      developer: "",
      user: ""
    },
    output: {
      raw: "",
      parsed: null
    },
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    },
    summary: "",
    error: null
  };
}

function buildRun(input, baseUrl, model) {
  const generationMode = normalizeMode(input.generationMode);
  return {
    id: `run-${crypto.randomUUID()}`,
    status: "queued",
    createdAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    currentStep: null,
    error: null,
    baseUrl,
    model,
    generationMode,
    input,
    finalMarkdown: "",
    latestSummary: "",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    },
    steps:
      generationMode === "fast"
        ? [
            createStep("blueprint", "快速蓝图", 0.3, 1400),
            createStep("draft", "快速正文", 0.6, Math.max(1400, Math.round(input.length * 2.1)))
          ]
        : [
            createStep("structure", "结构设计", 0.3, 1200),
            createStep("characters", "人物设计", 0.4, 1500),
            createStep("scenes", "场景设计", 0.3, 1700),
            createStep("draft", "正文生成", 0.6, Math.max(1800, Math.round(input.length * 2.3)))
          ]
  };
}

function loadStoredRuns() {
  const entries = fs.existsSync(RUNS_DIR)
    ? fs.readdirSync(RUNS_DIR, { withFileTypes: true }).filter(entry => entry.isDirectory())
    : [];

  const runs = [];

  for (const entry of entries) {
    const runJsonPath = path.join(RUNS_DIR, entry.name, "run.json");
    if (!fs.existsSync(runJsonPath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(runJsonPath, "utf8"));
      runs.push(data);
    } catch (error) {
      continue;
    }
  }

  return runs.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

async function handleCreateRun(req, res) {
  try {
    const payload = await parseBody(req);
    const apiKey = ensureText(payload.apiKey);
    const baseUrl = normalizeBaseUrl(payload.baseUrl);
    const model = ensureText(payload.model, "gpt-4o-mini");
    const input = {
      style: normalizeGenre(payload.style),
      protagonist: ensureText(payload.protagonist),
      premise: ensureText(payload.premise),
      hook: ensureText(payload.hook),
      audience: ensureText(payload.audience),
      length: clampLength(payload.length),
      generationMode: normalizeMode(payload.generationMode)
    };

    if (!apiKey) {
      sendJson(res, 400, { error: "请提供 API Key。" });
      return;
    }

    if (!input.premise) {
      sendJson(res, 400, { error: "请填写故事梗概。" });
      return;
    }

    const run = buildRun(input, baseUrl, model);
    runStore.set(run.id, run);
    saveRun(run);

    processRun(run, { apiKey, baseUrl, model }).catch(error => {
      run.status = "failed";
      run.error = error.message || "Unknown error.";
      saveRun(run);
    });

    sendJson(res, 202, {
      runId: run.id,
      status: run.status
    });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Unknown error." });
  }
}

async function handleValidateConfig(req, res) {
  try {
    const payload = await parseBody(req);
    const apiKey = ensureText(payload.apiKey);
    const baseUrl = normalizeBaseUrl(payload.baseUrl);
    const model = ensureText(payload.model);

    if (!apiKey) {
      sendJson(res, 400, { error: "请先填写 API Key。" });
      return;
    }

    const result = await validateApiConfig({ apiKey, baseUrl, model });
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, 500, { error: error.message || "连接测试失败。" });
  }
}

function handleListRuns(res) {
  const inMemory = [...runStore.values()].map(createRunSnapshot);
  const persisted = loadStoredRuns();
  const merged = new Map();

  for (const run of [...persisted, ...inMemory]) {
    merged.set(run.id, run);
  }

  const list = [...merged.values()]
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 20)
    .map(run => ({
      id: run.id,
      status: run.status,
      createdAt: run.createdAt,
      completedAt: run.completedAt,
      style: run.input?.style || "",
      premise: run.input?.premise || "",
      latestSummary: run.latestSummary || "",
      hasFinal: Boolean(run.finalMarkdown)
    }));

  sendJson(res, 200, { runs: list });
}

function handleGetRun(req, res, runId) {
  const run = runStore.get(runId);
  if (!run) {
    sendJson(res, 404, { error: "Run not found." });
    return;
  }
  sendJson(res, 200, createRunSnapshot(run));
}

function handleDeleteRun(res, runId) {
  const persisted = path.join(RUNS_DIR, runId, "run.json");
  const existsInMemory = runStore.has(runId);
  const existsOnDisk = fs.existsSync(persisted);

  if (!existsInMemory && !existsOnDisk) {
    sendJson(res, 404, { error: "Run not found." });
    return;
  }

  const liveRun = runStore.get(runId);
  if (liveRun && (liveRun.status === "queued" || liveRun.status === "running")) {
    sendJson(res, 409, {
      error: "运行中任务不能删除，请等待完成。当前版本暂不支持取消。"
    });
    return;
  }

  runStore.delete(runId);

  const clients = eventStreams.get(runId) || [];
  for (const client of clients) {
    try {
      client.end();
    } catch (error) {
      // ignore stream shutdown failures
    }
  }
  eventStreams.delete(runId);
  deleteRunArtifacts(runId);

  sendJson(res, 200, {
    ok: true,
    deleted: runId
  });
}

function handleEvents(req, res, runId) {
  const run = runStore.get(runId);
  if (!run) {
    sendJson(res, 404, { error: "Run not found." });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });

  res.write(`event: snapshot\ndata: ${JSON.stringify(createRunSnapshot(run))}\n\n`);

  const clients = eventStreams.get(runId) || [];
  clients.push(res);
  eventStreams.set(runId, clients);

  req.on("close", () => {
    const nextClients = (eventStreams.get(runId) || []).filter(client => client !== res);
    eventStreams.set(runId, nextClients);
  });
}

function handleHealth(res) {
  sendJson(res, 200, {
    ok: true,
    service: "novel-generator",
    host: HOST,
    port: PORT
  });
}

function handleAccessInfo(res) {
  sendJson(res, 200, getAccessInfo());
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/health") {
    handleHealth(res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/access-info") {
    handleAccessInfo(res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/validate-config") {
    handleValidateConfig(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/runs") {
    handleListRuns(res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/runs") {
    handleCreateRun(req, res);
    return;
  }

  const runMatch = url.pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (req.method === "GET" && runMatch) {
    handleGetRun(req, res, runMatch[1]);
    return;
  }

  if (req.method === "DELETE" && runMatch) {
    handleDeleteRun(res, runMatch[1]);
    return;
  }

  const eventMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/events$/);
  if (req.method === "GET" && eventMatch) {
    handleEvents(req, res, eventMatch[1]);
    return;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  const target = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, target));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "Forbidden." });
    return;
  }
  sendFile(res, filePath);
});

server.listen(PORT, HOST, () => {
  const info = getAccessInfo();
  console.log("Novel generator is ready.");
  console.log(`Local: ${info.localUrl}`);
  if (info.lanUrls.length) {
    console.log("LAN:");
    for (const url of info.lanUrls) {
      console.log(`  ${url}`);
    }
  } else {
    console.log("LAN: no IPv4 address detected.");
  }
});
