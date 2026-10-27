import { describe, expect, test } from "vitest";
import { resolveMigrationTarget } from "../../scripts/supabase-migration-target";

const source = {
  NEXT_PUBLIC_SUPABASE_URL: "https://brtdyxidblyimqteduph.supabase.co",
  SUPABASE_DB_PASSWORD: "not-a-real-password",
};
const london = {
  NEXT_PUBLIC_SUPABASE_URL: "https://vyuyifegaacqigkzgiws.supabase.co",
  SUPABASE_DB_PASSWORD: "not-a-real-password",
};

describe("migration database target", () => {
  test("derives the direct database host from the configured project", () => {
    expect(resolveMigrationTarget(source)).toMatchObject({
      projectRef: "brtdyxidblyimqteduph",
      host: "db.brtdyxidblyimqteduph.supabase.co",
      port: 5432,
      user: "postgres",
    });
    expect(resolveMigrationTarget(london).host).toBe("db.vyuyifegaacqigkzgiws.supabase.co");
  });

  test("allows a pooler only with the matching project tenant", () => {
    expect(resolveMigrationTarget({
      ...london,
      SUPABASE_DB_HOST: "aws-0-eu-west-2.pooler.supabase.com",
      SUPABASE_DB_USER: "postgres.vyuyifegaacqigkzgiws",
    }).user).toBe("postgres.vyuyifegaacqigkzgiws");
    expect(() => resolveMigrationTarget({
      ...london,
      SUPABASE_DB_HOST: "aws-1-ap-northeast-2.pooler.supabase.com",
      SUPABASE_DB_USER: "postgres.brtdyxidblyimqteduph",
    })).toThrow(/must match/);
  });

  test("rejects invalid URLs, unrelated hosts, and ports", () => {
    expect(() => resolveMigrationTarget({ ...source, NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321" })).toThrow(/HTTPS/);
    expect(() => resolveMigrationTarget({ ...source, SUPABASE_DB_HOST: "db.another.supabase.co" })).toThrow(/must be/);
    expect(() => resolveMigrationTarget({ ...source, SUPABASE_DB_PORT: "0" })).toThrow(/valid TCP port/);
    expect(() => resolveMigrationTarget({ NEXT_PUBLIC_SUPABASE_URL: source.NEXT_PUBLIC_SUPABASE_URL })).toThrow(/required/);
  });
});
