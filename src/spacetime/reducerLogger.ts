/**
 * Centralized reducer logging for SpaceTimeDB calls
 */

interface CallerInfo {
  functionName: string;
  location: string;
}

/**
 * Extract caller information from stack trace
 */
function extractCallerInfo(): CallerInfo {
  const stack = new Error().stack || '';
  const lines = stack.split('\n');

  // Skip the first few lines (Error, extractCallerInfo, logReducerCall, callReducer*)
  // and find the first meaningful caller
  for (let i = 3; i < Math.min(lines.length, 10); i++) {
    const line = lines[i];

    // Match patterns like:
    // "at functionName (file:line:col)"
    // "at file:line:col"
    const atMatch = line.match(/at\s+(?:([^\s]+)\s+\()?([^)]+):(\d+):(\d+)/);
    if (atMatch) {
      const [, funcName, file, lineNum, colNum] = atMatch;
      const fileName = file.split('/').pop() || file;

      return {
        functionName: funcName || '<anonymous>',
        location: `${fileName}:${lineNum}:${colNum}`
      };
    }
  }

  return {
    functionName: '<unknown>',
    location: '<unknown>'
  };
}

/**
 * Log reducer call results
 */
export function logReducerCall(
  reducerName: string,
  status: 'success' | 'error',
  message?: string
): void {
  const label = '[REDUCER]';

  if (status === 'success') {
    if (!message) {
      // Success with no message - log as warning
      // console.log(`${label} ${reducerName} - success (no message)`);
    } else {
      // console.log(`${label} ${reducerName} - ${message}`);
    }
  } else {
    // Error case
    const caller = extractCallerInfo();

    if (!message) {
      console.error(
        `${label} ${reducerName} - ERROR: No error message returned from reducer`,
        `\n  Called from: ${caller.functionName} (${caller.location})`
      );
    } else {
      console.error(
        `${label} ${reducerName} - ERROR: ${message}`,
        `\n  Called from: ${caller.functionName} (${caller.location})`
      );
    }
  }
}

