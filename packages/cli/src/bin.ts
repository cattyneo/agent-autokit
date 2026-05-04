#!/usr/bin/env bun
import { getAutokitVersion } from "./index.js";

if (import.meta.main) {
  console.log(`autokit ${getAutokitVersion()}`);
}
