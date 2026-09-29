import os from 'node:os'
import path from 'node:path'
export const launcherHome = () => process.env.DEVSPEC_LAUNCHER_HOME || path.join(os.homedir(), '.devspec', 'launcher')
