import { final } from '@libs/decorators/final.decorator';

// Compile-time regression: @final must retain statics and constructor arguments.
// This fixture is checked by the existing typecheck command, not the test runner.
@final
export class FinalWithStatics {
  static readonly kind = 'example';

  constructor(readonly value: string) {}

  static create(value: string): FinalWithStatics {
    return new FinalWithStatics(value);
  }
}

export const fromFactory: FinalWithStatics = FinalWithStatics.create('factory');
export const fromConstructor: FinalWithStatics = new FinalWithStatics(
  'constructor',
);
export const staticValue: 'example' = FinalWithStatics.kind;
export const instanceValue: string = fromConstructor.value;
