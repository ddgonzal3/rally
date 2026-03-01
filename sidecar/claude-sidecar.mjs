import { query } from '@anthropic-ai/claude-agent-sdk';
import { createInterface } from 'readline';
import { randomUUID } from 'crypto';

const rl = createInterface({ input: process.stdin, terminal: false });
const pendingPermissions = new Map(); // request_id -> { resolve, input }
let abortController = null;

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function handleError(err) {
  emit({ type: 'result', subtype: 'error', error: String(err) });
}

rl.on('line', (line) => {
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch (e) {
    handleError(`Invalid JSON: ${line}`);
    return;
  }

  switch (cmd.cmd) {
    case 'start':
      startSession(cmd).catch(handleError);
      break;
    case 'user_message':
      break; // V2
    case 'permission_response': {
      const pending = pendingPermissions.get(cmd.request_id);
      if (pending) {
        pendingPermissions.delete(cmd.request_id);
        if (cmd.decision === 'allow') {
          pending.resolve({ behavior: 'allow', updatedInput: pending.input });
        } else {
          pending.resolve({ behavior: 'deny', message: cmd.message || 'User denied' });
        }
      }
      break;
    }
    case 'cancel':
      if (abortController) abortController.abort();
      break;
  }
});

async function startSession({ prompt, cwd }) {
  abortController = new AbortController();
  try {
    const conversation = query({
      prompt,
      options: {
        cwd,
        abortController,
        canUseTool: async (toolName, input) => {
          const requestId = randomUUID();
          emit({
            type: 'permission_request',
            request_id: requestId,
            tool_name: toolName,
            tool_input: input,
          });
          return new Promise((resolve) => {
            pendingPermissions.set(requestId, { resolve, input });
          });
        },
      },
    });
    for await (const msg of conversation) {
      emit(msg);
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      emit({ type: 'result', subtype: 'error', error: 'Cancelled by user' });
    } else {
      handleError(err);
    }
  }
}

rl.on('close', () => {
  if (abortController) abortController.abort();
  process.exit(0);
});
