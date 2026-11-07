// Test-only shell metadata carrier. This fixture never executes shell commands.
import {Service} from '@deepseek-ai/cordis';
export default class TestShell extends Service {
  constructor(ctx){super(ctx,'shell');this.sandboxMode='danger-full-access';}
}
