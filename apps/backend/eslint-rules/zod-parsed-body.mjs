/**
 * Zod-parsed body rule.
 *
 * Handlers here take `@Body() body: unknown` on purpose: the DTO type is a Zod
 * schema, not a class, so the global ValidationPipe has nothing to validate.
 * That makes the parse call the only thing standing between a request payload
 * and the service, and a handler that forgets it accepts anything.
 *
 * The rule fires on a `@Body()` parameter typed `unknown` or `any` whose handler
 * contains no parse call. A parse call is either a helper named `parseSomething`
 * (`parseBody(...)`, `this.parseQuery(...)`) or a zod method (`Schema.safeParse`,
 * `Schema.parse`).
 *
 * It is plain ESM with no build step so eslint.config.js can import it directly.
 */

const HELPER_CALL = /^parse[A-Z]/;
const ZOD_METHODS = new Set(['parse', 'safeParse', 'parseAsync', 'safeParseAsync']);

/** Callee of a call expression, unwrapped from optional chaining. */
function calleeOf(node) {
  if (node?.type !== 'CallExpression') return null;
  let callee = node.callee;
  if (callee?.type === 'ChainExpression') callee = callee.expression;
  return callee ?? null;
}

function isParseCall(node) {
  const callee = calleeOf(node);
  if (callee === null) return false;
  if (callee.type === 'Identifier') return HELPER_CALL.test(callee.name);
  if (callee.type === 'MemberExpression' && callee.computed === false) {
    const name = callee.property?.name;
    if (typeof name !== 'string') return false;
    return HELPER_CALL.test(name) || ZOD_METHODS.has(name);
  }
  return false;
}

/** Walks a function body without descending into nested functions. */
function bodyParses(body) {
  if (body === null || body === undefined) return false;
  const queue = [body];
  while (queue.length > 0) {
    const node = queue.pop();
    if (node === null || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      queue.push(...node);
      continue;
    }
    if (isParseCall(node)) return true;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'parent') continue;
      if (value !== null && typeof value === 'object') queue.push(value);
    }
  }
  return false;
}

function isBodyParam(param) {
  return (param.decorators ?? []).some((decorator) => {
    const expression = decorator.expression;
    const callee = expression?.type === 'CallExpression' ? expression.callee : expression;
    return callee?.type === 'Identifier' && callee.name === 'Body';
  });
}

function isUnvalidatedType(param) {
  const annotation = param.typeAnnotation?.typeAnnotation;
  // No annotation at all is an implicit `any`, which is the same hole.
  if (annotation === undefined) return true;
  return annotation.type === 'TSUnknownKeyword' || annotation.type === 'TSAnyKeyword';
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'A @Body() typed unknown/any must be parsed by a Zod schema in the handler',
    },
    schema: [],
    messages: {
      unparsed:
        'The `{{name}}` parameter reaches the service unvalidated: it is typed unknown/any and the handler never parses it. Add `parseBody(SomeSchema, body)` or `SomeSchema.safeParse(body)` and throw BadRequestException on failure.',
    },
  },

  create(context) {
    const reported = new Set();

    function check(fn) {
      let flagged = null;
      for (const param of fn.params ?? []) {
        if (param.type !== 'Identifier' || !isBodyParam(param)) continue;
        if (isUnvalidatedType(param)) flagged = param;
      }
      if (flagged === null || reported.has(flagged)) return;
      if (bodyParses(fn.body)) return;
      reported.add(flagged);
      context.report({
        node: flagged,
        messageId: 'unparsed',
        data: { name: flagged.name },
      });
    }

    return {
      FunctionDeclaration: check,
      FunctionExpression: check,
      ArrowFunctionExpression: check,
    };
  },
};
