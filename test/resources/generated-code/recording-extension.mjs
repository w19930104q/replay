// Recording RunnerExtension test double. Extending the real base class makes
// it pass the `instanceof RunnerExtension` check so no browser is launched.
import { RunnerExtension } from '@puppeteer/replay';

export class RecordingExtension extends RunnerExtension {
  constructor() {
    super();
    this.steps = [];
    this.hooks = [];
  }

  async beforeAllSteps() {
    this.hooks.push('beforeAll');
  }

  async afterAllSteps() {
    this.hooks.push('afterAll');
  }

  async runStep(step) {
    this.steps.push(step);
  }
}

export default RecordingExtension;
