import { channelExecutors } from './channels.js';
import { dataExecutors } from './data.js';
import { logicExecutors } from './logic.js';
import { memberExecutors } from './members.js';
import { messageExecutors } from './messages.js';
import { roleExecutors } from './roles.js';

export const executors = {
  ...messageExecutors, ...memberExecutors, ...channelExecutors, ...roleExecutors, ...dataExecutors, ...logicExecutors,
};
