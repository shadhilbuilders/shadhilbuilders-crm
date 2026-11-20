// Rule tests for eslint-rules/zod-parsed-body.mjs.
//
// The rule exists because every request body in this app is `unknown` and
// validated by a Zod schema in the handler, so the parse call IS the validation.
// These cases pin what counts as a parse, and that a handler without one is
// reported, so the rule cannot quietly rot into a no-op.
import { Linter, type Rule } from 'eslint';
import tsParser from '@typescript-eslint/parser';
import { describe, expect, it } from 'vitest';

// Typed as `string` on purpose: the rule is a plain .mjs file with no
// declarations, and a literal type here would make TypeScript try to resolve it.
const RULE_PATH: string = '../../eslint-rules/zod-parsed-body.mjs';

async function loadRule(): Promise<Rule.RuleModule> {
  const mod = (await import(RULE_PATH)) as { default: Rule.RuleModule };
  return mod.default;
}

async function lint(code: string): Promise<string[]> {
  const linter = new Linter({ configType: 'flat' });
  const rule = await loadRule();
  const config = [
    {
      files: ['**/*.ts'],
      languageOptions: { parser: tsParser, ecmaVersion: 2024, sourceType: 'module' },
      plugins: { local: { rules: { 'zod-parsed-body': rule } } },
      rules: { 'local/zod-parsed-body': 'error' },
    },
  ] as unknown as Linter.Config[];
  return linter.verify(code, config, 'probe.ts').map((m) => m.message);
}

describe('local/zod-parsed-body', () => {
  it('reports a handler that never parses its unknown body', async () => {
    const messages = await lint(`
      class C {
        @Post()
        async create(@Body() body: unknown) {
          return this.service.create(body);
        }
      }
    `);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('never parses it');
  });

  it('accepts a parseBody helper call', async () => {
    const messages = await lint(`
      class C {
        @Post()
        async create(@Body() body: unknown) {
          const dto = parseBody(CreateSchema, body);
          return this.service.create(dto);
        }
      }
    `);
    expect(messages).toEqual([]);
  });

  it('accepts Schema.safeParse through a this.parseBody helper', async () => {
    const messages = await lint(`
      class C {
        @Post()
        async create(@Body() body: unknown) {
          return this.ok(this.parseBody(CreateSchema, body));
        }
      }
    `);
    expect(messages).toEqual([]);
  });

  it('accepts an inline safeParse', async () => {
    const messages = await lint(`
      class C {
        @Post()
        async create(@Body() body: unknown) {
          const parsed = CreateSchema.safeParse(body);
          if (!parsed.success) throw new BadRequestException('bad');
          return this.service.create(parsed.data);
        }
      }
    `);
    expect(messages).toEqual([]);
  });

  it('ignores a body that is already typed', async () => {
    const messages = await lint(`
      class C {
        @Post()
        async create(@Body() body: CreateDto) {
          return this.service.create(body);
        }
      }
    `);
    expect(messages).toEqual([]);
  });

  it('ignores parameters that are not @Body', async () => {
    const messages = await lint(`
      class C {
        @Get()
        async list(@Query() query: unknown) {
          return this.service.list(query);
        }
      }
    `);
    expect(messages).toEqual([]);
  });

  it('reports an untyped @Body too, since it is an implicit any', async () => {
    const messages = await lint(`
      class C {
        @Post()
        async create(@Body() body) {
          return this.service.create(body);
        }
      }
    `);
    expect(messages).toHaveLength(1);
  });
});
