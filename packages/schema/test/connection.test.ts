import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Connection } from "../src/connection.js"

for (const credentialType of ["key", "oauth"] as const) {
  test(`preserves ${credentialType} connection metadata`, () => {
    const input = { type: "credential", id: "cred_test", label: "Account", credentialType } as const
    const value = Schema.decodeUnknownSync(Connection.Info)(input)
    expect(Schema.encodeSync(Connection.Info)(value)).toEqual(input)
  })
}

test("accepts older connection metadata and omits an undefined credential type", () => {
  const input = { type: "credential", id: "cred_test", label: "Account" } as const
  const value = Schema.decodeUnknownSync(Connection.CredentialInfo)(input)
  expect(Schema.encodeSync(Connection.CredentialInfo)({ ...value, credentialType: undefined })).toEqual(input)
})

test("rejects an unknown credential type", () => {
  expect(() =>
    Schema.decodeUnknownSync(Connection.Info)({
      type: "credential",
      id: "cred_test",
      label: "Account",
      credentialType: "password",
    }),
  ).toThrow()
})
