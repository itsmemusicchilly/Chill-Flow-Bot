// Limits shared by the editor (to stop you early) and the server (which enforces them).
export const LIMITS = {
  flowsPerGuild: 25,
  nodesPerFlow: 150,
  edgesPerFlow: 400,
  nodeDataBytes: 24 * 1024,
  graphBytes: 600 * 1024,
  varsPerGuild: 2000,
  varValueBytes: 8 * 1024,
  runsPer10s: 40, // per guild
  concurrentRuns: 15, // per guild
  actionsPer10s: 25, // mutating Discord actions per guild
  stepsPerRun: 500,
  loopIterations: 100,
  waitSeconds: 300,
  modalWaitMs: 10 * 60 * 1000,
  maxComponents: 25,
};
