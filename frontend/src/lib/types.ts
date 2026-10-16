// Shapes of the web UI API's responses (src/webui.js), as far as the page reads them.

export interface PeerRef {
  name: string;
  url: string;
}

/** A shared project in the local registry (data/registry.json). */
export interface SharedEntry {
  name: string;
  path: string;
  leader?: boolean;
  peers?: { name: string; leader?: boolean }[];
}

/** `GET api/status`. */
export interface Status {
  token: string;
  selfUrl: string | null;
  tunnelUrl: string | null;
  tunnelStarting?: boolean;
  projectsRoot: string;
  shared: SharedEntry[];
  peers: PeerRef[];
}

/** One row of `GET api/projects`: a git repo under PROJECTS_ROOT. */
export interface ProjectRow {
  name: string;
  path: string;
  shared: boolean;
}

/** `GET api/peer-status?peer=…`: the peer's own `/control/status`. */
export interface PeerCatalog {
  shared?: { name: string }[];
}

/** `GET api/sync-status` and `POST api/sync`: ahead/behind against the peer. */
export interface SyncState {
  state: string;
  ahead: number;
  behind: number;
}
