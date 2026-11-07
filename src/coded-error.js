'use strict';
// An Error with a stable machine code. `message` is what the CLI, the web UI and legacy callers see;
// `brief` (optional) is the shorter refusal text the MCP tools use where the message folds a list in;
// `details` is a plain object of names and plugin-controlled values, never a URL, token or git stderr.
class CodedError extends Error {
  constructor(code, message, details, brief) {
    super(message);
    this.code = code;
    this.details = details;
    this.brief = brief;
  }
}

module.exports = { CodedError };
