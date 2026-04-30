#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const DEFAULT_TEMPLATE_CONFIG_PATH = join(REPO_ROOT, "railway.openclaw.config.json");
const DEFAULT_PERSONA_TEMPLATE_PATH = join(
  REPO_ROOT,
  "deploy",
  "railway",
  "workspaces",
  "discord-jester",
  "AGENTS.md",
);
const DEFAULT_DISCORD_AGENT_ID = "discord-jester";
const DEFAULT_DISCORD_AGENT_NAME = "Grumbleghast";
const DEFAULT_CHECKIN_TIMEZONE = "UTC";
const DEFAULT_CHECKIN_TIMES = ["09:15", "13:15", "18:15", "22:15"];
const DEFAULT_CHECKIN_PROMPT = [
  "Post one short in-character Discord message as Grumbleghast.",
  "If there is an obvious recent theme in the room, riff on it briefly.",
  "If not, post a funny, self-contained non sequitur.",
  "Keep it to 1-2 sentences, theatrical and grumpy, not helpful or formal.",
  "If nothing amusing comes to mind, reply with NO_REPLY.",
].join(" ");
const MANAGED_CHECKIN_JOB_ID_PREFIX = "railway-discord-checkin";
const MANAGED_CHECKIN_JOB_NAME_PREFIX = "Discord Check-in";

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseCsvEnv(value) {
  if (typeof value !== "string") {
    return [];
  }
  const seen = new Set();
  const entries = [];
  for (const rawPart of value.split(",")) {
    const part = rawPart.trim();
    if (!part || seen.has(part)) {
      continue;
    }
    seen.add(part);
    entries.push(part);
  }
  return entries;
}

function parseBooleanEnv(value, fallback) {
  if (typeof value !== "string" || value.trim() === "") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function normalizeOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJsonFile(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function ensureObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function findAgent(config, agentId = DEFAULT_DISCORD_AGENT_ID) {
  return ensureArray(config?.agents?.list).find((entry) => entry?.id === agentId) ?? null;
}

function ensureDiscordAgent(config, templateConfig, agentId = DEFAULT_DISCORD_AGENT_ID) {
  const existingAgent = findAgent(config, agentId);
  if (existingAgent) {
    return existingAgent;
  }
  const templateAgent = findAgent(templateConfig, agentId);
  if (!templateAgent) {
    return null;
  }
  config.agents = ensureObject(config.agents);
  const list = ensureArray(config.agents.list);
  const nextAgent = cloneJson(templateAgent);
  list.push(nextAgent);
  config.agents.list = list;
  return nextAgent;
}

function parseCheckinTimes(value) {
  const rawTimes = parseCsvEnv(value);
  const times = rawTimes.length > 0 ? rawTimes : DEFAULT_CHECKIN_TIMES;
  const normalized = [];
  const seen = new Set();
  for (const rawTime of times) {
    const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(rawTime);
    if (!match) {
      continue;
    }
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    const normalizedTime = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    if (seen.has(normalizedTime)) {
      continue;
    }
    seen.add(normalizedTime);
    normalized.push(normalizedTime);
  }
  return normalized;
}

function buildDiscordCheckinSpec(params = {}) {
  const env = params.env ?? process.env;
  const rawChannelId = normalizeOptionalString(env.OPENCLAW_DISCORD_CHECKIN_CHANNEL_ID);
  if (!rawChannelId) {
    return null;
  }
  // "last" means post to whichever Discord channel the bot was most recently active in.
  const channelId = rawChannelId === "last" ? null : rawChannelId;
  const timezone =
    normalizeOptionalString(env.OPENCLAW_DISCORD_CHECKIN_TIMEZONE) ??
    normalizeOptionalString(env.TZ) ??
    DEFAULT_CHECKIN_TIMEZONE;
  const times = parseCheckinTimes(env.OPENCLAW_DISCORD_CHECKIN_TIMES);
  if (times.length === 0) {
    return null;
  }
  const prompt = normalizeOptionalString(env.OPENCLAW_DISCORD_CHECKIN_PROMPT) ?? DEFAULT_CHECKIN_PROMPT;
  return {
    channelId,
    timezone,
    times,
    prompt,
    accountId: normalizeOptionalString(env.OPENCLAW_DISCORD_ACCOUNT_ID),
  };
}

function buildDiscordCheckinJobs(params = {}) {
  const env = params.env ?? process.env;
  const spec = params.spec ?? buildDiscordCheckinSpec({ env });
  if (!spec) {
    return [];
  }
  const nowMs =
    typeof params.nowMs === "number" && Number.isFinite(params.nowMs) ? params.nowMs : Date.now();
  return spec.times.map((time, index) => {
    const [hour, minute] = time.split(":");
    return {
      id: `${MANAGED_CHECKIN_JOB_ID_PREFIX}-${index + 1}`,
      agentId: DEFAULT_DISCORD_AGENT_ID,
      name: `${MANAGED_CHECKIN_JOB_NAME_PREFIX} ${index + 1}`,
      description: `Managed Railway Discord check-in at ${time} ${spec.timezone}`,
      enabled: true,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      schedule: {
        kind: "cron",
        expr: `${Number(minute)} ${Number(hour)} * * *`,
        tz: spec.timezone,
      },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: {
        kind: "agentTurn",
        message: spec.prompt,
      },
      delivery: {
        mode: "announce",
        channel: "discord",
        ...(spec.channelId ? { to: `channel:${spec.channelId}` } : {}),
        ...(spec.accountId ? { accountId: spec.accountId } : {}),
      },
      state: {},
    };
  });
}

function mergeManagedCronJobs(params = {}) {
  const env = params.env ?? process.env;
  const store = cloneJson(params.store ?? { version: 1, jobs: [] });
  const managedJobs = buildDiscordCheckinJobs({ env, nowMs: params.nowMs, spec: params.spec });
  const unmanagedJobs = ensureArray(store.jobs).filter(
    (job) => !(typeof job?.id === "string" && job.id.startsWith(`${MANAGED_CHECKIN_JOB_ID_PREFIX}-`)),
  );
  store.version = 1;
  store.jobs = [...unmanagedJobs];
  for (const managedJob of managedJobs) {
    const existingJob = ensureArray(params.store?.jobs).find((job) => job?.id === managedJob.id);
    if (existingJob) {
      store.jobs.push({
        ...managedJob,
        createdAtMs:
          typeof existingJob.createdAtMs === "number" && Number.isFinite(existingJob.createdAtMs)
            ? existingJob.createdAtMs
            : managedJob.createdAtMs,
        updatedAtMs: managedJob.updatedAtMs,
      });
      continue;
    }
    store.jobs.push(managedJob);
  }
  return store;
}

function resolveCronStorePath(config, stateDir) {
  const configuredPath = normalizeOptionalString(config?.cron?.store);
  return configuredPath || join(stateDir, "cron", "jobs.json");
}

// When the auth command writes a minimal config (no agents.list), rebuild from
// the template so structural sections aren't lost, but carry over auth credentials.
function resolveBootstrapBase(existingConfig, templateConfig) {
  if (!existingConfig) {
    return templateConfig;
  }
  if (ensureArray(existingConfig?.agents?.list).length > 0) {
    return existingConfig;
  }
  const base = cloneJson(templateConfig);
  if (existingConfig.auth) {
    base.auth = existingConfig.auth;
  }
  const existingModels = existingConfig?.agents?.defaults?.models;
  if (existingModels && typeof existingModels === "object" && !Array.isArray(existingModels)) {
    base.agents = ensureObject(base.agents);
    base.agents.defaults = ensureObject(base.agents.defaults);
    base.agents.defaults.models = {
      ...existingModels,
      ...ensureObject(base.agents.defaults.models),
    };
  }
  return base;
}

export function buildRailwayBootstrapConfig(params = {}) {
  const env = params.env ?? process.env;
  const templateConfig = cloneJson(
    params.templateConfig ?? readJsonFile(DEFAULT_TEMPLATE_CONFIG_PATH),
  );
  const baseConfig = cloneJson(params.baseConfig ?? templateConfig);
  const nextConfig = baseConfig;
  const guildId = env.OPENCLAW_DISCORD_GUILD_ID?.trim();
  const allowedUserIds = parseCsvEnv(env.OPENCLAW_DISCORD_ALLOWED_USER_IDS);
  const checkinSpec = buildDiscordCheckinSpec({ env });
  const allowedChannelIds = [
    ...new Set([
      ...parseCsvEnv(env.OPENCLAW_DISCORD_CHANNEL_IDS),
      ...(checkinSpec?.channelId ? [checkinSpec.channelId] : []),
    ]),
  ];
  const requireMention = parseBooleanEnv(env.OPENCLAW_DISCORD_REQUIRE_MENTION, true);
  const automaticGroupReplies = parseBooleanEnv(
    env.OPENCLAW_DISCORD_AUTOMATIC_GROUP_REPLIES,
    true,
  );
  const discordTokenEnv = env.OPENCLAW_DISCORD_TOKEN_ENV?.trim() || "DISCORD_BOT_TOKEN";
  const discordAgentName = env.OPENCLAW_DISCORD_AGENT_NAME?.trim() || null;

  if (guildId) {
    ensureDiscordAgent(nextConfig, templateConfig);
  }

  const agent = findAgent(nextConfig);
  if (agent && discordAgentName) {
    agent.name = discordAgentName;
  }

  if (!guildId) {
    return nextConfig;
  }

  const guildConfig = {
    requireMention,
  };
  if (allowedUserIds.length > 0) {
    guildConfig.users = allowedUserIds;
  }
  if (allowedChannelIds.length > 0) {
    guildConfig.channels = Object.fromEntries(
      allowedChannelIds.map((channelId) => [channelId, { allow: true, requireMention }]),
    );
  }

  nextConfig.bindings = ensureArray(nextConfig.bindings).filter(
    (binding) =>
      !(
        binding?.agentId === DEFAULT_DISCORD_AGENT_ID &&
        binding?.match?.channel === "discord" &&
        binding?.match?.guildId === guildId
      ),
  );
  nextConfig.bindings.push({
    agentId: DEFAULT_DISCORD_AGENT_ID,
    match: {
      channel: "discord",
      guildId,
    },
  });

  nextConfig.channels = ensureObject(nextConfig.channels);
  const existingDiscord = ensureObject(nextConfig.channels.discord);
  const existingGuilds = ensureObject(existingDiscord.guilds);
  const nextGuildEntry = {
    ...ensureObject(existingGuilds[guildId]),
    ...guildConfig,
  };
  if (allowedChannelIds.length > 0) {
    nextGuildEntry.channels = guildConfig.channels;
  }
  if (allowedUserIds.length > 0) {
    nextGuildEntry.users = allowedUserIds;
  }
  nextConfig.channels.discord = {
    ...existingDiscord,
    enabled: true,
    dmPolicy: "pairing",
    groupPolicy: "allowlist",
    token: {
      source: "env",
      provider: "default",
      id: discordTokenEnv,
    },
    guilds: {
      ...existingGuilds,
      [guildId]: nextGuildEntry,
    },
  };

  if (automaticGroupReplies) {
    nextConfig.messages = ensureObject(nextConfig.messages);
    nextConfig.messages.groupChat = ensureObject(nextConfig.messages.groupChat);
    nextConfig.messages.groupChat.visibleReplies = "automatic";
  }

  return nextConfig;
}

export function resolveDiscordWorkspacePath(config, agentId = DEFAULT_DISCORD_AGENT_ID) {
  const agent = findAgent(config, agentId);
  return typeof agent?.workspace === "string" && agent.workspace.trim() ? agent.workspace : null;
}

export function seedRailwayBootstrapFiles(params = {}) {
  const env = params.env ?? process.env;
  const stateDir = env.OPENCLAW_STATE_DIR?.trim() || "/data/.openclaw";
  const configPath = env.OPENCLAW_CONFIG_PATH?.trim() || join(stateDir, "openclaw.json");
  const personaTemplateText =
    params.personaTemplateText ?? readFileSync(DEFAULT_PERSONA_TEMPLATE_PATH, "utf8");
  const templateConfig = params.templateConfig ?? readJsonFile(DEFAULT_TEMPLATE_CONFIG_PATH);
  const existingConfig = existsSync(configPath) ? readJsonFile(configPath) : null;
  const nextConfig = buildRailwayBootstrapConfig({
    env,
    baseConfig: params.baseConfig ?? resolveBootstrapBase(existingConfig, templateConfig),
    templateConfig,
  });

  let wroteConfig = false;
  if (!existingConfig || JSON.stringify(existingConfig) !== JSON.stringify(nextConfig)) {
    writeJsonFile(configPath, nextConfig);
    wroteConfig = true;
  }

  const activeConfig = wroteConfig ? nextConfig : (existingConfig ?? nextConfig);
  const workspacePath = resolveDiscordWorkspacePath(activeConfig);
  const discordEnabled = activeConfig?.channels?.discord?.enabled === true && Boolean(workspacePath);
  let wrotePersona = false;
  if (workspacePath) {
    const agentsPath = join(workspacePath, "AGENTS.md");
    if (!existsSync(agentsPath)) {
      mkdirSync(workspacePath, { recursive: true });
      writeFileSync(agentsPath, personaTemplateText, "utf8");
      wrotePersona = true;
    }
  }

  const cronStorePath = resolveCronStorePath(activeConfig, stateDir);
  const existingCronStore = existsSync(cronStorePath) ? readJsonFile(cronStorePath) : { version: 1, jobs: [] };
  const nextCronStore = mergeManagedCronJobs({
    env,
    store: existingCronStore,
    spec: discordEnabled ? buildDiscordCheckinSpec({ env }) : null,
  });
  let wroteCronStore = false;
  if (JSON.stringify(existingCronStore) !== JSON.stringify(nextCronStore)) {
    writeJsonFile(cronStorePath, nextCronStore);
    wroteCronStore = true;
  }

  return {
    configPath,
    cronStorePath,
    workspacePath,
    wroteConfig,
    wroteCronStore,
    wrotePersona,
  };
}

function isDirectInvocation() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isDirectInvocation()) {
  const result = seedRailwayBootstrapFiles();
  if (result.wroteConfig) {
    console.log(`[railway-bootstrap] seeded config: ${result.configPath}`);
  }
  if (result.wroteCronStore) {
    console.log(`[railway-bootstrap] seeded cron jobs: ${result.cronStorePath}`);
  }
  if (result.wrotePersona && result.workspacePath) {
    console.log(`[railway-bootstrap] seeded persona: ${join(result.workspacePath, "AGENTS.md")}`);
  }
}
