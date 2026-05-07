export const productionApiKeyEnvNames = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
] as const;

export type ProductionApiKeyEnvName = (typeof productionApiKeyEnvNames)[number];

export class ProductionApiKeyEnvError extends Error {
  readonly present: ProductionApiKeyEnvName[];

  constructor(present: ProductionApiKeyEnvName[]) {
    super(`${present.join(",")} must not be exported`);
    this.name = "ProductionApiKeyEnvError";
    this.present = present;
  }
}

export function assertProductionApiKeyEnvUnset(env: NodeJS.ProcessEnv): void {
  const present = productionApiKeyEnvNames.filter(
    (name) => env[name] !== undefined && env[name] !== "",
  );
  if (present.length > 0) {
    throw new ProductionApiKeyEnvError(present);
  }
}
