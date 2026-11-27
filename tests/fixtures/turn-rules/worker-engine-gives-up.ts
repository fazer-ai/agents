// A matcher thread whose engine gives up on the second pattern, as turn-rules.worker.ts reports it.
declare var self: Worker;

self.onmessage = () => {
  self.postMessage({ testing: 0 });
  self.postMessage({ testing: 1 });
  self.postMessage({ failed: 1 });
};
