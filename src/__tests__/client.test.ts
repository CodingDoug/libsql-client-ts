import { expect } from "@jest/globals";
import type { MatcherFunction } from "expect";

import "./helpers.js";

import type * as libsql from "..";
import { createClient } from "..";

const config = {
    url: process.env.URL ?? "ws://localhost:8080",
    authToken: process.env.AUTH_TOKEN,
};

const isWs = config.url.startsWith("ws:") || config.url.startsWith("wss:") || config.url.startsWith("libsql:");
const isHttp = config.url.startsWith("http:") || config.url.startsWith("https:");
const isFile = config.url.startsWith("file:");

function withClient(f: (c: libsql.Client) => Promise<void>): () => Promise<void> {
    return async () => {
        const c = createClient(config);
        try {
            await f(c);
        } finally {
            c.close();
        }
    };
}

describe("createClient()", () => {
    test("URL scheme not supported", () => {
        expect(() => createClient({url: "ftp://localhost"}))
            .toThrow(expect.toBeLibsqlError("URL_SCHEME_NOT_SUPPORTED", /"ftp:"/));
    });

    test("URL param not supported", () => {
        expect(() => createClient({url: "ws://localhost?foo=bar"}))
            .toThrow(expect.toBeLibsqlError("URL_PARAM_NOT_SUPPORTED", /"foo"/));
    });
});

describe("execute()", () => {
    test("query a single value", withClient(async (c) => {
        const rs = await c.execute("SELECT 42");
        expect(rs.columns.length).toStrictEqual(1);
        expect(rs.rows.length).toStrictEqual(1);
        expect(rs.rows[0].length).toStrictEqual(1);
        expect(rs.rows[0][0]).toStrictEqual(42);
    }));

    test("query a single row", withClient(async (c) => {
        const rs = await c.execute("SELECT 1 AS one, 'two' AS two, 0.5 AS three");
        expect(rs.columns).toStrictEqual(["one", "two", "three"]);
        expect(rs.rows.length).toStrictEqual(1);
        
        const r = rs.rows[0];
        expect(r.length).toStrictEqual(3);
        expect(Array.from(r)).toStrictEqual([1, "two", 0.5]);
        expect(Object.entries(r)).toStrictEqual([["one", 1], ["two", "two"], ["three", 0.5]]);
    }));

    test("query multiple rows", withClient(async (c) => {
        const rs = await c.execute("VALUES (1, 'one'), (2, 'two'), (3, 'three')");
        expect(rs.columns.length).toStrictEqual(2);
        expect(rs.rows.length).toStrictEqual(3);
        
        expect(Array.from(rs.rows[0])).toStrictEqual([1, "one"]);
        expect(Array.from(rs.rows[1])).toStrictEqual([2, "two"]);
        expect(Array.from(rs.rows[2])).toStrictEqual([3, "three"]);
    }));

    test("statement that produces error", withClient(async (c) => {
        await expect(c.execute("SELECT foobar")).rejects.toBeLibsqlError();
    }));

    test("rowsAffected with INSERT", withClient(async (c) => {
        await c.batch([
            "DROP TABLE IF EXISTS t",
            "CREATE TABLE t (a)",
        ]);
        const rs = await c.execute("INSERT INTO t VALUES (1), (2)");
        expect(rs.rowsAffected).toStrictEqual(2);
    }));

    test("rowsAffected with DELETE", withClient(async (c) => {
        await c.batch([
            "DROP TABLE IF EXISTS t",
            "CREATE TABLE t (a)",
            "INSERT INTO t VALUES (1), (2), (3), (4), (5)",
        ]);
        const rs = await c.execute("DELETE FROM t WHERE a >= 3");
        expect(rs.rowsAffected).toStrictEqual(3);
    }));

    test("lastInsertRowid with INSERT", withClient(async (c) => {
        await c.batch([
            "DROP TABLE IF EXISTS t",
            "CREATE TABLE t (a)",
            "INSERT INTO t VALUES ('one'), ('two')",
        ]);
        const insertRs = await c.execute("INSERT INTO t VALUES ('three')");
        expect(insertRs.lastInsertRowid).not.toBeUndefined();
        const selectRs = await c.execute({
            sql: "SELECT a FROM t WHERE ROWID = ?",
            args: [insertRs.lastInsertRowid!],
        });
        expect(Array.from(selectRs.rows[0])).toStrictEqual(["three"]);
    }));
});

describe("values", () => {
    function testRoundtrip(
        name: string,
        passed: libsql.InValue,
        expected: libsql.Value,
        opts: { skip?: boolean } = {},
    ): void {
        const skip = opts.skip ?? false;
        (skip ? test.skip : test)(name, withClient(async (c) => {
            const rs = await c.execute({sql: "SELECT ?", args: [passed]});
            expect(rs.rows[0][0]).toStrictEqual(expected);
        }));
    }

    testRoundtrip("string", "boomerang", "boomerang");
    testRoundtrip("string with weird characters", "a\n\r\t ", "a\n\r\t ");
    testRoundtrip("string with unicode",
        "žluťoučký kůň úpěl ďábelské ódy", "žluťoučký kůň úpěl ďábelské ódy");

    testRoundtrip("zero", 0, 0);
    testRoundtrip("integer", -2023, -2023);
    testRoundtrip("float", 12.345, 12.345);
    testRoundtrip("Infinity", Infinity, Infinity, {skip: true});
    testRoundtrip("NaN", NaN, NaN, {skip: true});

    const buf = new ArrayBuffer(256);
    const array = new Uint8Array(buf);
    for (let i = 0; i < 256; ++i) {
        array[i] = i ^ 0xab;
    }
    testRoundtrip("ArrayBuffer", buf, buf);
    testRoundtrip("Uint8Array", array, buf);

    testRoundtrip("null", null, null);
    testRoundtrip("true", true, 1);
    testRoundtrip("false", false, 0);
    
    testRoundtrip("bigint", -1267650600228229401496703205376n, "-1267650600228229401496703205376");
    testRoundtrip("Date", new Date("2023-01-02T12:34:56Z"), 1672662896000);

    test("undefined produces error", withClient(async (c) => {
        await expect(c.execute({
            sql: "SELECT ?",
            // @ts-expect-error
            args: [undefined],
        })).rejects.toBeInstanceOf(TypeError);
    }));
});

describe("arguments", () => {
    test("? arguments", withClient(async (c) => {
        const rs = await c.execute({
            sql: "SELECT ?, ?",
            args: ["one", "two"],
        });
        expect(Array.from(rs.rows[0])).toStrictEqual(["one", "two"]);
    }));

    (!isFile ? test : test.skip)("?NNN arguments", withClient(async (c) => {
        const rs = await c.execute({
            sql: "SELECT ?2, ?3, ?1",
            args: ["one", "two", "three"],
        });
        expect(Array.from(rs.rows[0])).toStrictEqual(["two", "three", "one"]);
    }));

    (!isFile ? test : test.skip)("?NNN arguments with holes", withClient(async (c) => {
        const rs = await c.execute({
            sql: "SELECT ?3, ?1",
            args: ["one", "two", "three"],
        });
        expect(Array.from(rs.rows[0])).toStrictEqual(["three", "one"]);
    }));

    (!isFile ? test : test.skip)("?NNN and ? arguments", withClient(async (c) => {
        const rs = await c.execute({
            sql: "SELECT ?2, ?, ?3",
            args: ["one", "two", "three"],
        });
        expect(Array.from(rs.rows[0])).toStrictEqual(["two", "three", "three"]);
    }));

    for (const sign of [":", "@", "$"]) {
        test(`${sign}AAAA arguments`, withClient(async (c) => {
            const rs = await c.execute({
                sql: `SELECT ${sign}b, ${sign}a`,
                args: {"a": "one", [`${sign}b`]: "two"},
            });
            expect(Array.from(rs.rows[0])).toStrictEqual(["two", "one"]);
        }));

        test(`${sign}AAAA arguments used multiple times`, withClient(async (c) => {
            const rs = await c.execute({
                sql: `SELECT ${sign}b, ${sign}a, ${sign}b || ${sign}a`,
                args: {"a": "one", [`${sign}b`]: "two"},
            });
            expect(Array.from(rs.rows[0])).toStrictEqual(["two", "one", "twoone"]);
        }));

        test(`${sign}AAAA arguments and ?NNN arguments`, withClient(async (c) => {
            const rs = await c.execute({
                sql: `SELECT ${sign}b, ${sign}a, ?1`,
                args: {"a": "one", [`${sign}b`]: "two"},
            });
            expect(Array.from(rs.rows[0])).toStrictEqual(["two", "one", "two"]);
        }));
    }
});

describe("batch()", () => {
    test("multiple queries", withClient(async (c) => {
        const rss = await c.batch([
            "SELECT 1+1",
            "SELECT 1 AS one, 2 AS two",
            {sql: "SELECT ?", args: ["boomerang"]},
            {sql: "VALUES (?), (?)", args: ["big", "ben"]},
        ]);

        expect(rss.length).toStrictEqual(4);
        const [rs0, rs1, rs2, rs3] = rss;

        expect(rs0.rows.length).toStrictEqual(1);
        expect(Array.from(rs0.rows[0])).toStrictEqual([2]);

        expect(rs1.rows.length).toStrictEqual(1);
        expect(Array.from(rs1.rows[0])).toStrictEqual([1, 2]);

        expect(rs2.rows.length).toStrictEqual(1);
        expect(Array.from(rs2.rows[0])).toStrictEqual(["boomerang"]);

        expect(rs3.rows.length).toStrictEqual(2);
        expect(Array.from(rs3.rows[0])).toStrictEqual(["big"]);
        expect(Array.from(rs3.rows[1])).toStrictEqual(["ben"]);
    }));

    test("statements are executed sequentially", withClient(async (c) => {
        const rss = await c.batch([
            /* 0 */ "DROP TABLE IF EXISTS t",
            /* 1 */ "CREATE TABLE t (a, b)",
            /* 2 */ "INSERT INTO t VALUES (1, 'one')",
            /* 3 */ "SELECT * FROM t ORDER BY a",
            /* 4 */ "INSERT INTO t VALUES (2, 'two')",
            /* 5 */ "SELECT * FROM t ORDER BY a",
            /* 6 */ "DROP TABLE t",
        ]);

        expect(rss.length).toStrictEqual(7);
        expect(rss[3].rows).toEqual([
            {a: 1, b: "one"},
        ]);
        expect(rss[5].rows).toEqual([
            {a: 1, b: "one"},
            {a: 2, b: "two"},
        ]);
    }));

    test("statements are executed in a transaction", withClient(async (c) => {
        await c.batch([
            "DROP TABLE IF EXISTS t1",
            "DROP TABLE IF EXISTS t2",
            "CREATE TABLE t1 (a)",
            "CREATE TABLE t2 (a)",
        ]);

        const n = 100;
        const promises = [];
        for (let i = 0; i < n; ++i) {
            const ii = i;
            promises.push((async () => {
                const rss = await c.batch([
                    {sql: "INSERT INTO t1 VALUES (?)", args: [ii]},
                    {sql: "INSERT INTO t2 VALUES (?)", args: [ii * 10]},
                    "SELECT SUM(a) FROM t1",
                    "SELECT SUM(a) FROM t2",
                ]);

                const sum1 = rss[2].rows[0][0] as number;
                const sum2 = rss[3].rows[0][0] as number;
                expect(sum2).toStrictEqual(sum1 * 10);
            })());
        }
        await Promise.all(promises);

        const rs1 = await c.execute("SELECT SUM(a) FROM t1");
        expect(rs1.rows[0][0]).toStrictEqual(n*(n-1)/2);
        const rs2 = await c.execute("SELECT SUM(a) FROM t2");
        expect(rs2.rows[0][0]).toStrictEqual(n*(n-1)/2*10);
    }));

    test("error in batch", withClient(async (c) => {
        await expect(c.batch([
            "SELECT 1+1",
            "SELECT foobar",
        ])).rejects.toBeLibsqlError();
    }));

    test("error in batch rolls back transaction", withClient(async (c) => {
        await c.execute("DROP TABLE IF EXISTS t");
        await c.execute("CREATE TABLE t (a)");
        await c.execute("INSERT INTO t VALUES ('one')");
        await expect(c.batch([
            "INSERT INTO t VALUES ('two')",
            "SELECT foobar",
            "INSERT INTO t VALUES ('three')",
        ])).rejects.toBeLibsqlError();

        const rs = await c.execute("SELECT COUNT(*) FROM t");
        expect(rs.rows[0][0]).toStrictEqual(1);
    }));
});

(!isHttp ? describe : describe.skip)("transaction()", () => {
    test("query multiple rows", withClient(async (c) => {
        const txn = await c.transaction();

        const rs = await txn.execute("VALUES (1, 'one'), (2, 'two'), (3, 'three')");
        expect(rs.columns.length).toStrictEqual(2);
        expect(rs.rows.length).toStrictEqual(3);

        expect(Array.from(rs.rows[0])).toStrictEqual([1, "one"]);
        expect(Array.from(rs.rows[1])).toStrictEqual([2, "two"]);
        expect(Array.from(rs.rows[2])).toStrictEqual([3, "three"]);

        txn.close();
    }));

    test("commit()", withClient(async (c) => {
        await c.batch([
            "DROP TABLE IF EXISTS t",
            "CREATE TABLE t (a)",
        ]);

        const txn = await c.transaction();
        await txn.execute("INSERT INTO t VALUES ('one')");
        await txn.execute("INSERT INTO t VALUES ('two')");
        expect(txn.closed).toStrictEqual(false);
        await txn.commit();
        expect(txn.closed).toStrictEqual(true);

        const rs = await c.execute("SELECT COUNT(*) FROM t");
        expect(rs.rows[0][0]).toStrictEqual(2);
        await expect(txn.execute("SELECT 1")).rejects.toBeLibsqlError("TRANSACTION_CLOSED");
    }));

    test("rollback()", withClient(async (c) => {
        await c.batch([
            "DROP TABLE IF EXISTS t",
            "CREATE TABLE t (a)",
        ]);

        const txn = await c.transaction();
        await txn.execute("INSERT INTO t VALUES ('one')");
        await txn.execute("INSERT INTO t VALUES ('two')");
        expect(txn.closed).toStrictEqual(false);
        await txn.rollback();
        expect(txn.closed).toStrictEqual(true);

        const rs = await c.execute("SELECT COUNT(*) FROM t");
        expect(rs.rows[0][0]).toStrictEqual(0);
        await expect(txn.execute("SELECT 1")).rejects.toBeLibsqlError("TRANSACTION_CLOSED");
    }));

    test("close()", withClient(async (c) => {
        await c.batch([
            "DROP TABLE IF EXISTS t",
            "CREATE TABLE t (a)",
        ]);

        const txn = await c.transaction();
        await txn.execute("INSERT INTO t VALUES ('one')");
        expect(txn.closed).toStrictEqual(false);
        txn.close();
        expect(txn.closed).toStrictEqual(true);

        const rs = await c.execute("SELECT COUNT(*) FROM t");
        expect(rs.rows[0][0]).toStrictEqual(0);
        await expect(txn.execute("SELECT 1")).rejects.toBeLibsqlError("TRANSACTION_CLOSED");
    }));

    test("error does not rollback", withClient(async (c) => {
        await c.batch([
            "DROP TABLE IF EXISTS t",
            "CREATE TABLE t (a)",
        ]);

        const txn = await c.transaction();
        await expect(txn.execute("SELECT foobar")).rejects.toBeLibsqlError();
        await txn.execute("INSERT INTO t VALUES ('one')");
        await txn.commit();

        const rs = await c.execute("SELECT COUNT(*) FROM t");
        expect(rs.rows[0][0]).toStrictEqual(1);
    }));
});

(isWs ? describe : describe.skip)("network errors", () => {
    const testCases = [
        {title: "WebSocket close", sql: ".close_ws"},
        {title: "TCP close", sql: ".close_tcp"},
    ];

    for (const {title, sql} of testCases) {
        test(`${title} in execute()`, withClient(async (c) => {
            await expect(c.execute(sql)).rejects.toBeLibsqlError("HRANA_WEBSOCKET_ERROR");

            expect((await c.execute("SELECT 42")).rows[0][0]).toStrictEqual(42);
        }));

        test(`${title} in transaction()`, withClient(async (c) => {
            const txn = await c.transaction();
            await expect(txn.execute(sql)).rejects.toBeLibsqlError("HRANA_WEBSOCKET_ERROR");
            await expect(txn.commit()).rejects.toBeLibsqlError("HRANA_CLOSED_ERROR");
            txn.close();

            expect((await c.execute("SELECT 42")).rows[0][0]).toStrictEqual(42);
        }));

        test(`${title} in batch()`, withClient(async (c) => {
            await expect(c.batch(["SELECT 42", sql, "SELECT 24"]))
                .rejects.toBeLibsqlError("HRANA_WEBSOCKET_ERROR");

            expect((await c.execute("SELECT 42")).rows[0][0]).toStrictEqual(42);
        }));
    }
});

(isHttp ? test : test.skip)("transaction() not supported", withClient(async (c) => {
    await expect(c.transaction()).rejects.toBeLibsqlError("TRANSACTIONS_NOT_SUPPORTED");
}));
