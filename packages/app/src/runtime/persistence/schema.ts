export * as Persistence from "./schema"

import { Effect, Option, Predicate, Result, Schema, SchemaAST, SchemaGetter, SchemaParser, Struct } from "effect"

export type Migrated<S extends Schema.ConstraintCodec<object, unknown>> = {
  current: S
  read: Schema.ConstraintDecoder<unknown>
}

export function migrate<S extends Schema.ConstraintCodec<object, unknown>>(
  current: S,
  read: Schema.ConstraintDecoder<unknown>,
): Migrated<S> {
  return { current, read }
}

function isMigrated<S extends Schema.ConstraintCodec<object, unknown>>(schema: S | Migrated<S>): schema is Migrated<S> {
  return "current" in schema
}

export function withInitial<S extends Schema.ConstraintCodec<object, unknown>>(
  definition: S | Migrated<S>,
  initial: NoInfer<S["Type"]>,
) {
  const schema = isMigrated(definition) ? definition.current : definition
  const read = isMigrated(definition)
    ? SchemaParser.decodeUnknownResult(
        Schema.make<Schema.ConstraintDecoder<unknown>>(preserveExcess(definition.read.ast)),
      )
    : Result.succeed<unknown>
  const encode = Schema.encodeUnknownSync(schema)
  return Schema.Unknown.pipe(
    Schema.decode<Schema.Unknown>({
      decode: SchemaGetter.transformEffect((value) =>
        Effect.fromResult(Result.map(read(value), (stored) => merge(initial, recover(schema.ast, stored, initial)))),
      ),
      encode: SchemaGetter.transform((value) => encode(value)),
    }),
    Schema.decodeTo(Schema.toType(schema)),
  )
}

// Migration decoders must carry fields they do not know yet into the current schema. Effect 4.0
// no longer exposes the parser-level `preserve` option, so make closed structs open recursively.
function preserveExcess(ast: SchemaAST.AST): SchemaAST.AST {
  const encoding = ast.encoding && preserveEncoding(ast.encoding)
  const recurred = "recur" in ast && typeof ast.recur === "function" ? ast.recur(preserveExcess) : ast
  const next = withEncoding(recurred, encoding)
  if (next._tag !== "Objects") return next
  const indexSignatures =
    next.propertySignatures.length === 0 || next.indexSignatures.length > 0
      ? next.indexSignatures
      : [
          new SchemaAST.IndexSignature(Schema.String.ast, Schema.Unknown.ast),
          new SchemaAST.IndexSignature(Schema.Symbol.ast, Schema.Unknown.ast),
        ]
  return new SchemaAST.Objects(
    next.propertySignatures,
    indexSignatures,
    next.annotations,
    next.checks,
    encoding,
    next.context,
    next.encodingChecks,
  )
}

function preserveEncoding(encoding: SchemaAST.Encoding): SchemaAST.Encoding {
  return [
    new SchemaAST.Link(preserveExcess(encoding[0].to), encoding[0].transformation),
    ...encoding.slice(1).map((link) => new SchemaAST.Link(preserveExcess(link.to), link.transformation)),
  ]
}

function withEncoding(ast: SchemaAST.AST, encoding: SchemaAST.Encoding | undefined): SchemaAST.AST {
  if (ast.encoding === encoding) return ast
  const descriptors = Object.getOwnPropertyDescriptors(ast)
  descriptors.encoding.value = encoding
  return Object.create(Object.getPrototypeOf(ast), descriptors)
}

// Object-level codecs own their recovery. Plain structs can recover fields independently.
function recover(ast: SchemaAST.AST, value: unknown, initial: unknown): unknown {
  if (value === undefined) return initial
  if (ast._tag === "Objects" && !ast.encoding && ast.indexSignatures.length === 0 && Predicate.isObject(value)) {
    return Object.fromEntries(
      ast.propertySignatures.flatMap((field) => {
        const defaults = Predicate.isObject(initial) ? initial[field.name] : undefined
        const next = recover(field.type, value[field.name], defaults)
        if (next === undefined && !Object.hasOwn(value, field.name) && defaults === undefined) return []
        return [[field.name, next]]
      }),
    )
  }
  const decoded = Schema.decodeUnknownOption(Schema.make<Schema.Codec<unknown, unknown>>(ast))(value)
  return Option.isSome(decoded) ? decoded.value : initial
}

function merge(initial: unknown, value: unknown): unknown {
  if (value === undefined) return initial
  if (!Predicate.isObject(initial) || !Predicate.isObject(value)) return value
  return Object.fromEntries(
    [...new Set([...Object.keys(initial), ...Object.keys(value)])].map((key) => [key, merge(initial[key], value[key])]),
  )
}

// Unlike a decoding default, a fallback also replaces invalid persisted values.
export function fallback<S extends Schema.ConstraintCodec<unknown, unknown>>(schema: S, value: () => S["Type"]) {
  const defaulted = Schema.withDecodingDefaultType<S>(Effect.sync(value))(schema)
  return Schema.catchDecoding<typeof defaulted>(() => Effect.sync(() => Option.some(value())))(defaulted)
}

export function optional<S extends Schema.ConstraintCodec<unknown, unknown>>(schema: S) {
  const field = Schema.optional(schema)
  return Schema.catchDecoding<typeof field>(() => Effect.succeed(Option.none()))(field)
}

export function struct<const Fields extends Schema.Struct.Fields>(fields: Fields) {
  return Schema.Struct(fields).mapFields(Struct.map(Schema.mutableKey))
}

export function record<S extends Schema.ConstraintCodec<unknown, unknown>>(schema: S) {
  const entries = Schema.Record(Schema.String, Schema.mutableKey(schema))
  return fallback(entries, () => Schema.decodeUnknownSync(entries)({}))
}

// Recover individual entries rather than discarding a whole history or collection.
export function array<S extends Schema.ConstraintCodec<unknown, unknown>>(schema: S) {
  const decode = Schema.decodeUnknownOption(schema)
  const encode = Schema.encodeSync(schema)
  return fallback(
    Schema.Array(Schema.Unknown).pipe(
      Schema.decodeTo(Schema.mutable(Schema.Array(Schema.toType(schema))), {
        decode: SchemaGetter.transform((items) => items.flatMap((item) => Option.toArray(decode(item)))),
        encode: SchemaGetter.transform((items) => items.map((item) => encode(item))),
      }),
    ),
    () => [],
  )
}
