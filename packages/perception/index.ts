import type { PerceptionProvider, UIStateGraph, UIElement } from '../core/index.js';

const rootElement: UIElement = {
  id: 'root',
  role: 'WINDOW',
  label: 'Mock Window',
  states: ['enabled'],
  childIds: [],
  metadata: {},
};

export class MockPerceptionProvider implements PerceptionProvider {
  readonly providerKind = 'mock';
  private signatureCounter = 0;

  async observe(): Promise<UIStateGraph> {
    this.signatureCounter += 1;
    return {
      windowId: 'mock-window',
      title: 'Mock UI',
      elements: [rootElement],
      timestamp: Date.now(),
      stateSignature: `mock-${this.signatureCounter}`,
    };
  }
}