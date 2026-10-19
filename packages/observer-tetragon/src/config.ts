import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root: packages/observer-tetragon/src -> ../../.. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export const TETRAGON_IMAGE = "quay.io/cilium/tetragon:v1.7.0";
export const TETRAGON_EXPECTED_VERSION = "v1.7.0";
export const TETRAGON_CONTAINER = "kw-tetragon";
export const KW_LABEL = "kw-dev=1";
/**
 * Prometheus metrics address INSIDE kw-tetragon. The container runs with --network none, so this is reachable only
 * through `docker exec kw-tetragon wget ...` (no published port: Docker Desktop forwards published host-loopback
 * ports to containers via host.docker.internal, which let an agent container read them - verified in review).
 */
export const TETRAGON_METRICS_ADDR = "127.0.0.1:2112";
/** Export file is rotated by Tetragon at this size; large enough that a demo run never rotates mid-capture. */
export const TETRAGON_EXPORT_MAX_MB = 512;

export interface ObserverPaths {
  /** Host directory for everything this package writes. Never mount it into an agent container. */
  dataDir: string;
  /** Host directory bind-mounted at /var/log/tetragon inside kw-tetragon only. */
  exportDir: string;
  /** Tetragon's JSON export file (VM-wide: contains every container's events). */
  exportFile: string;
  policiesDir: string;
  enforcementRegistryFile: string;
  runDir(runId: string): string;
}

export function observerPaths(overrides: { dataDir?: string; policiesDir?: string } = {}): ObserverPaths {
  const dataDir = resolve(
    overrides.dataDir ?? process.env.KW_TETRAGON_DATA_DIR ?? join(REPO_ROOT, "data", "observer", "tetragon"),
  );
  const exportDir = join(dataDir, "export");
  return {
    dataDir,
    exportDir,
    exportFile: join(exportDir, "tetragon.log"),
    policiesDir: resolve(overrides.policiesDir ?? join(REPO_ROOT, "docker", "tetragon", "policies")),
    enforcementRegistryFile: join(dataDir, "enforcement-registry.json"),
    runDir: (runId: string) => {
      if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error(`invalid run id for a directory name: ${runId}`);
      return join(dataDir, runId);
    },
  };
}
