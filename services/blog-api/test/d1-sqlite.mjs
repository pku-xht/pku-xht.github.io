import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

// The Worker uses only D1's API. This test adapter executes actual SQLite SQL,
// foreign keys, transactions, JSON1 functions, uniqueness constraints, triggers.
export function sqliteD1(path = ':memory:') {
  const sqlite = new DatabaseSync(path);
  sqlite.exec('PRAGMA foreign_keys = ON;');
  if (!sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'public_documents'").get()) sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8'));
  const database = {
    sqlite, writes: 0, lastError: null,
    prepare(sql) {
      const make = values => ({
        bind(...next) { return make(next); },
        execute() {
          try {
            const statement=sqlite.prepare(sql);
            const write=!/^\s*(?:SELECT|WITH\b.*?SELECT)/is.test(sql);
            if (write) database.writes++;
            if (/^\s*SELECT/i.test(sql) || /\bRETURNING\b/i.test(sql)) {
              const results=statement.all(...values).map(row=>({...row}));
              return {success:true,results,meta:{changes:write?results.length:0}};
            }
            const result=statement.run(...values);
            return {success:true,results:[],meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)}};
          } catch(error) { database.lastError={sql,error}; throw error; }
        },
        async first(column) { const result=this.execute().results[0]||null; return column?(result?.[column]??null):result; },
        async all() { return this.execute(); },
        async run() { return this.execute(); },
      });
      return make([]);
    },
    async batch(statements) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results=statements.map(statement=>statement.execute());
        sqlite.exec('COMMIT'); return results;
      } catch(error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    close() { sqlite.close(); },
  };
  return database;
}

export function testDatabase() {
  const database = sqliteD1();
  database.sqlite.exec("INSERT INTO public_documents(id,kind) VALUES ('11','post'),('12','post'),('215','page'); INSERT INTO legacy_parents(id,document) VALUES ('wp-1','11'),('wp-2','12');");
  return database;
}
