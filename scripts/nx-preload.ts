// Nx otherwise forces color in children even when the caller requests NO_COLOR.
// Its FORCE_COLOR=0 handling keeps nested tasks uncolored without conflicting flags.
if (env.NO_COLOR !== undefined) env.FORCE_COLOR = '0';
import { env } from 'node:process';
