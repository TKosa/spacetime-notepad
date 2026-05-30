import { NotepadApp } from './ui/notepad/notepadApp';

const originalConsoleLog = console.log.bind(console);
const originalConsoleWarn = console.warn.bind(console);
const originalConsoleError = console.error.bind(console);

const isBenignUnknownQuerySetMessage = (args: unknown[]): boolean => {
  const text = args.map((arg) => String(arg)).join(' ');
  return (
    text.includes('Received SubscriptionError for unknown querySetId') &&
    text.includes('Subscription not found')
  );
};

console.log = (...args: unknown[]) => {
  if (isBenignUnknownQuerySetMessage(args)) {
    return;
  }
  originalConsoleLog(...args);
};

console.warn = (...args: unknown[]) => {
  if (isBenignUnknownQuerySetMessage(args)) {
    return;
  }
  originalConsoleWarn(...args);
};

console.error = (...args: unknown[]) => {
  if (isBenignUnknownQuerySetMessage(args)) {
    return;
  }
  originalConsoleError(...args);
};

const root = document.getElementById('notepad-app');
if (!root) {
  throw new Error('Missing #notepad-app root element');
}

new NotepadApp(root);
