#!/usr/bin/env node
// The CLI is TypeScript; tsx compiles it on the way in so there is no build step.
import { register } from "tsx/esm/api";

register();
await import(new URL("../src/cli.ts", import.meta.url).href);
