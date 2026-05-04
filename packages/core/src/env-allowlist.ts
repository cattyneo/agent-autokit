export type ParentEnv = Record<string, string | undefined>;
export type ChildEnv = Record<string, string>;

export type RunnerEnvOptions = {
  home?: string;
  xdgConfigHome?: string;
  xdgCacheHome?: string;
};

const COMMON_EXACT_KEYS = new Set(["PATH", "HOME", "USER", "LOGNAME", "LANG", "TERM", "TZ"]);
const XDG_KEYS = new Set(["XDG_CONFIG_HOME", "XDG_CACHE_HOME"]);
const GH_TOKEN_KEYS = new Set(["GH_TOKEN", "GITHUB_TOKEN"]);

export function buildGhEnv(parentEnv: ParentEnv): ChildEnv {
  const env = copyCommonEnv(parentEnv);
  copyExactKeys(parentEnv, env, GH_TOKEN_KEYS);
  copyExactKeys(parentEnv, env, XDG_KEYS);
  return env;
}

export function buildRunnerEnv(parentEnv: ParentEnv, options: RunnerEnvOptions = {}): ChildEnv {
  const env = copyCommonEnv(parentEnv);
  copyExactKeys(parentEnv, env, XDG_KEYS);

  overrideIfDefined(env, "HOME", options.home);
  overrideIfDefined(env, "XDG_CONFIG_HOME", options.xdgConfigHome);
  overrideIfDefined(env, "XDG_CACHE_HOME", options.xdgCacheHome);

  return env;
}

function copyCommonEnv(parentEnv: ParentEnv): ChildEnv {
  const env: ChildEnv = {};

  for (const [key, value] of Object.entries(parentEnv)) {
    if (typeof value !== "string") {
      continue;
    }
    if (COMMON_EXACT_KEYS.has(key) || key.startsWith("LC_")) {
      env[key] = value;
    }
  }

  return env;
}

function copyExactKeys(parentEnv: ParentEnv, env: ChildEnv, keys: Set<string>): void {
  for (const key of keys) {
    const value = parentEnv[key];
    if (typeof value === "string") {
      env[key] = value;
    }
  }
}

function overrideIfDefined(env: ChildEnv, key: string, value: string | undefined): void {
  if (value !== undefined) {
    env[key] = value;
  }
}
