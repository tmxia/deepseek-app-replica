package io.github.lijiahua1024.dsreplica;

import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteException;
import android.database.sqlite.SQLiteOpenHelper;
import android.util.Log;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/** SQLite owns both the active history and the transactional import staging area. */
final class ChatStorage extends SQLiteOpenHelper {
    private static final String NAME = "chat-history.sqlite";
    private static final String TAG = "ChatStorage";
    private static final int PAGE_SIZE = 64;
    private static final int TEXT_CHUNK = 256 * 1024;
    private static final int CLEANUP_BATCH = 256;
    private static final int MIGRATION_PENDING = 0;
    private static final int LEGACY_CAN_RETIRE = 1;
    private static final int LEGACY_RETIRED = 2;
    private static final int LEGACY_RETAINED = 3;
    private static ChatStorage instance;

    private final Context context;
    private final SharedPreferences preferences;
    private final ChatFiles files;
    private final ExecutorService maintenance = Executors.newSingleThreadExecutor();
    private boolean maintenanceQueued;
    private boolean opened;

    static synchronized ChatStorage get(Context context) {
        if (instance == null) instance = new ChatStorage(context.getApplicationContext());
        return instance;
    }

    private ChatStorage(Context context) {
        // Android's default corruption handler deletes the database. Preserve it for recovery.
        super(context, NAME, 1, new SQLiteDatabase.OpenParams.Builder()
            .setErrorHandler(db -> Log.e(TAG, "Chat database is corrupt"))
            .setJournalMode("WAL")
            .setSynchronousMode("FULL")
            .build());
        this.context = context;
        preferences = context.getSharedPreferences("chat-storage", Context.MODE_PRIVATE);
        files = new ChatFiles(context.getFilesDir());
        setWriteAheadLoggingEnabled(true);
    }

    @Override
    public void onConfigure(SQLiteDatabase db) {
        db.setForeignKeyConstraintsEnabled(true);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE state (id INTEGER PRIMARY KEY CHECK(id=1), slot INTEGER NOT NULL, "
            + "token TEXT, legacy INTEGER NOT NULL, revision INTEGER NOT NULL)");
        db.execSQL("INSERT INTO state VALUES (1, 0, NULL, ?, 0)", new Object[]{MIGRATION_PENDING});
        db.execSQL("CREATE TABLE sessions (slot INTEGER NOT NULL, id TEXT NOT NULL, title TEXT NOT NULL, "
            + "created REAL NOT NULL, updated REAL NOT NULL, data BLOB NOT NULL, PRIMARY KEY(slot,id))");
        db.execSQL("CREATE TABLE refs (slot INTEGER NOT NULL, session TEXT NOT NULL, file TEXT NOT NULL, "
            + "PRIMARY KEY(slot,session,file), FOREIGN KEY(slot,session) REFERENCES sessions(slot,id) "
            + "ON DELETE CASCADE)");
        db.execSQL("CREATE INDEX refs_by_file ON refs(slot,file)");
        db.execSQL("CREATE TABLE files (slot INTEGER NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL, "
            + "object TEXT NOT NULL, override INTEGER NOT NULL, PRIMARY KEY(slot,id))");
        db.execSQL("CREATE INDEX files_by_object ON files(object)");
        db.execSQL("CREATE TABLE garbage (object TEXT PRIMARY KEY)");
        db.execSQL("CREATE TRIGGER retired_file AFTER DELETE ON files BEGIN "
            + "INSERT OR IGNORE INTO garbage VALUES (old.object); END");
        db.execSQL("CREATE TRIGGER replaced_file AFTER UPDATE OF object ON files "
            + "WHEN old.object<>new.object BEGIN INSERT OR IGNORE INTO garbage VALUES (old.object); END");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        throw new SQLiteException("Unsupported chat database upgrade");
    }

    private record State(int slot, String token, int legacy, long revision) {
        int staged() { return 1 - slot; }
    }

    private SQLiteDatabase database() {
        boolean installed = preferences.getBoolean("installed", false);
        if (installed && !context.getDatabasePath(NAME).isFile()) {
            throw new SQLiteException("The installed chat database is missing");
        }
        SQLiteDatabase db = getWritableDatabase();
        if (!opened) {
            if (installed && state(db).legacy() == MIGRATION_PENDING) {
                throw new SQLiteException("The installed chat database has lost its migration state");
            }
            db.execSQL("UPDATE state SET token=NULL WHERE id=1");
            opened = true;
            scheduleMaintenance(true);
        }
        return db;
    }

    private static State state(SQLiteDatabase db) {
        try (Cursor cursor = db.rawQuery("SELECT slot,token,legacy,revision FROM state WHERE id=1", null)) {
            if (!cursor.moveToFirst()) throw new SQLiteException("Missing chat storage state");
            return new State(cursor.getInt(0), cursor.getString(1), cursor.getInt(2), cursor.getLong(3));
        }
    }

    private boolean markInstalled() {
        return preferences.getBoolean("installed", false)
            || preferences.edit().putBoolean("installed", true).commit();
    }

    synchronized String request(Object owner, String method, String payload) {
        try {
            Object result = execute(owner, method, new JSONObject(payload));
            return new JSONObject().put("value", result == null ? JSONObject.NULL : result).toString();
        } catch (Exception error) {
            // Exceptions may include bound chat data. Log the operation and exception type only.
            Log.e(TAG, method + " failed (" + error.getClass().getSimpleName() + ")");
            return "{\"error\":\"Android chat storage operation failed\"}";
        }
    }

    synchronized InputStream openAttachment(String token) throws IOException {
        return files.open(token);
    }

    synchronized void disconnect(Object owner) {
        files.abandonAll(owner);
    }

    private Object execute(Object owner, String method, JSONObject args) throws Exception {
        if ("abandon".equals(method)) {
            files.abandon(owner, args.getString("object"));
            return null;
        }
        if ("append".equals(method)) {
            files.append(owner, args.getString("object"), args.getString("data"));
            return null;
        }
        SQLiteDatabase db = database();
        State state = state(db);
        int slot = state.slot();
        String token = args.optString("token");
        if (!token.isEmpty() && !token.equals(state.token())) {
            if ("discard".equals(method)) return null;
            throw new IllegalStateException("History staging was replaced");
        }
        int target = token.isEmpty() ? slot : state.staged();
        boolean migrating = state.legacy() == MIGRATION_PENDING;
        if (migrating && token.isEmpty()
                && !"needsMigration".equals(method) && !"begin".equals(method)) {
            throw new IllegalStateException("Legacy history migration is pending");
        }
        switch (method) {
            case "needsMigration":
                if (!migrating) markInstalled();
                return migrating;
            case "retired":
                if (state.legacy() == LEGACY_CAN_RETIRE && markInstalled()) {
                    db.execSQL("UPDATE state SET legacy=? WHERE id=1", new Object[]{LEGACY_RETIRED});
                }
                return null;
            case "upload":
                return files.begin(owner);
            case "canRetire":
                return state.legacy() == LEGACY_CAN_RETIRE && markInstalled();
            case "summaries":
                return readSummaries(db, target, args);
            case "ids":
                return readIds(db, target, args);
            case "read":
                return readSession(db, target, args.getString("id"));
            case "file":
                try (Cursor cursor = db.rawQuery("SELECT object,type FROM files WHERE slot=? AND id=?",
                        keys(target, args.getString("id")))) {
                    return cursor.moveToFirst()
                        ? new JSONObject().put("object", cursor.getString(0)).put("type", cursor.getString(1))
                        : null;
                }
            case "fileTypes":
                boolean includeStaged = args.optBoolean("includeStaged");
                if (includeStaged) requireStaging(token);
                return readFileTypes(db, state, args.getJSONArray("ids"), includeStaged);
            case "begin":
                if (migrating != args.optBoolean("migration")) {
                    throw new IllegalStateException("Unexpected history migration state");
                }
                String next = UUID.randomUUID().toString();
                transaction(db, () -> {
                    clearSlot(db, state.staged());
                    db.execSQL("UPDATE state SET token=? WHERE id=1", new Object[]{next});
                });
                return next;
            case "revision":
                return Long.toString(state.revision());
            case "write":
                write(db, owner, target, token, args);
                if (args.getJSONArray("files").length() != 0) scheduleMaintenance(false);
                return null;
            case "remove":
                remove(db, target, token, args.getString("id"));
                if (token.isEmpty()) scheduleMaintenance(false);
                return null;
            case "discard":
                db.execSQL("UPDATE state SET token=NULL WHERE token=?", new Object[]{token});
                scheduleMaintenance(false);
                return null;
            case "replace":
                requireStaging(token);
                int legacy = state.legacy();
                if (migrating) {
                    legacy = args.optBoolean("retainLegacy") ? LEGACY_RETAINED : LEGACY_CAN_RETIRE;
                } else if (legacy == LEGACY_RETAINED) {
                    // An explicit full replacement also retires any previous recovery copy.
                    legacy = LEGACY_CAN_RETIRE;
                }
                db.execSQL("UPDATE state SET slot=?,token=NULL,legacy=?,revision=revision+1 WHERE id=1",
                    new Object[]{state.staged(), legacy});
                if (migrating) markInstalled();
                scheduleMaintenance(false);
                return null;
            case "merge":
                requireStaging(token);
                if (!Long.toString(state.revision()).equals(args.getString("revision"))) {
                    throw new IllegalStateException("Active history changed during merge");
                }
                commitMerge(db, slot, state.staged());
                scheduleMaintenance(false);
                return null;
            default:
                throw new IllegalArgumentException("Unknown chat storage operation");
        }
    }

    private static void requireStaging(String token) {
        if (token.isEmpty()) throw new IllegalStateException("Missing history staging token");
    }

    private static String[] keys(int slot, String id) {
        return new String[]{String.valueOf(slot), id};
    }

    private static String sessionPage(JSONObject args) {
        return " FROM sessions WHERE slot=?" + (args.has("after") ? " AND id>?" : "")
            + " ORDER BY id LIMIT " + PAGE_SIZE;
    }

    private static String[] pageKeys(int slot, JSONObject args) {
        return args.has("after") ? keys(slot, args.optString("after")) : new String[]{String.valueOf(slot)};
    }

    private static JSONArray readIds(SQLiteDatabase db, int slot, JSONObject args) {
        JSONArray ids = new JSONArray();
        try (Cursor cursor = db.rawQuery("SELECT id" + sessionPage(args), pageKeys(slot, args))) {
            while (cursor.moveToNext()) ids.put(cursor.getString(0));
        }
        return ids;
    }

    private static JSONArray readSummaries(SQLiteDatabase db, int slot, JSONObject args) throws Exception {
        JSONArray summaries = new JSONArray();
        List<JSONObject> longTitles = new ArrayList<>();
        try (Cursor cursor = db.rawQuery("SELECT id,created,updated,"
                + "CASE WHEN length(CAST(title AS BLOB))<=8192 THEN title END" + sessionPage(args),
                pageKeys(slot, args))) {
            while (cursor.moveToNext()) {
                JSONObject item = new JSONObject().put("id", cursor.getString(0))
                    .put("createdAt", cursor.getDouble(1)).put("updatedAt", cursor.getDouble(2));
                if (cursor.isNull(3)) longTitles.add(item);
                else item.put("title", cursor.getString(3));
                summaries.put(item);
            }
        }
        for (JSONObject item : longTitles) {
            item.put("title", readText(db, slot, item.getString("id"), "CAST(title AS BLOB)"));
        }
        return summaries;
    }

    private static String readSession(SQLiteDatabase db, int slot, String id) throws IOException {
        return readText(db, slot, id, "data");
    }

    private static String readText(SQLiteDatabase db, int slot, String id, String column) throws IOException {
        // CursorWindow cannot fit a multi-megabyte conversation in a single row.
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        for (int offset = 1; ; offset += TEXT_CHUNK) {
            try (Cursor cursor = db.rawQuery("SELECT substr(" + column + ",?," + TEXT_CHUNK
                    + ") FROM sessions WHERE slot=? AND id=?",
                    new String[]{String.valueOf(offset), String.valueOf(slot), id})) {
                if (!cursor.moveToFirst()) return null;
                byte[] chunk = cursor.getBlob(0);
                bytes.write(chunk);
                if (chunk.length < TEXT_CHUNK) return new String(bytes.toByteArray(), StandardCharsets.UTF_8);
            }
        }
    }

    private static JSONArray readFileTypes(SQLiteDatabase db, State state, JSONArray ids,
            boolean includeStaged) throws Exception {
        JSONArray types = new JSONArray();
        String query = includeStaged
            ? "SELECT type FROM files WHERE id=? AND slot IN (?,?) "
                + "ORDER BY CASE WHEN slot=? AND override=1 THEN 0 WHEN slot=? THEN 1 ELSE 2 END LIMIT 1"
            : "SELECT type FROM files WHERE slot=? AND id=?";
        String active = String.valueOf(state.slot());
        String staged = String.valueOf(state.staged());
        for (int i = 0; i < ids.length(); i++) {
            String id = ids.getString(i);
            String[] binds = includeStaged ? new String[]{id, active, staged, staged, active}
                : new String[]{active, id};
            try (Cursor cursor = db.rawQuery(query, binds)) {
                if (cursor.moveToFirst()) types.put(new JSONArray().put(id).put(cursor.getString(0)));
            }
        }
        return types;
    }

    private void write(SQLiteDatabase db, Object owner, int slot, String token, JSONObject args)
            throws Exception {
        JSONArray attachments = args.getJSONArray("files");
        JSONArray sessions = args.getJSONArray("sessions");
        List<String> objects = new ArrayList<>();
        for (int i = 0; i < attachments.length(); i++) {
            String object = attachments.getJSONObject(i).getString("object");
            files.prepare(owner, object);
            objects.add(object);
        }
        if (!objects.isEmpty()) files.syncDirectory();
        transaction(db, () -> {
            for (int i = 0; i < attachments.length(); i++) {
                JSONObject file = attachments.getJSONObject(i);
                String id = file.getString("id");
                ContentValues values = new ContentValues();
                values.put("type", file.getString("type"));
                values.put("object", file.getString("object"));
                values.put("override", args.optBoolean("overrideFiles") ? 1 : 0);
                if (db.update("files", values, "slot=? AND id=?", keys(slot, id)) == 0) {
                    values.put("slot", slot);
                    values.put("id", id);
                    db.insertOrThrow("files", null, values);
                }
            }
            for (int i = 0; i < sessions.length(); i++) {
                writeSession(db, slot, sessions.getJSONObject(i), args.optBoolean("add"));
            }
            if (token.isEmpty()) bumpRevision(db);
        });
        for (String object : objects) files.committed(object);
    }

    private static void writeSession(SQLiteDatabase db, int slot, JSONObject row, boolean add)
            throws Exception {
        String id = row.getString("id");
        ContentValues values = new ContentValues();
        values.put("title", row.getString("title"));
        values.put("created", row.getDouble("createdAt"));
        values.put("updated", row.getDouble("updatedAt"));
        values.put("data", row.getString("data").getBytes(StandardCharsets.UTF_8));
        if (add || db.update("sessions", values, "slot=? AND id=?", keys(slot, id)) == 0) {
            values.put("slot", slot);
            values.put("id", id);
            db.insertOrThrow("sessions", null, values);
        } else {
            db.delete("refs", "slot=? AND session=?", keys(slot, id));
        }
        JSONArray refs = row.getJSONArray("fileIds");
        for (int i = 0; i < refs.length(); i++) {
            db.execSQL("INSERT INTO refs VALUES (?,?,?)", new Object[]{slot, id, refs.getString(i)});
        }
    }

    private static void remove(SQLiteDatabase db, int slot, String token, String id) throws Exception {
        transaction(db, () -> {
            if (token.isEmpty()) {
                db.execSQL("DELETE FROM files WHERE slot=? AND id IN "
                    + "(SELECT file FROM refs WHERE slot=? AND session=?) AND NOT EXISTS "
                    + "(SELECT 1 FROM refs WHERE slot=files.slot AND file=files.id AND session<>?)",
                    new Object[]{slot, slot, id, id});
                bumpRevision(db);
            }
            db.delete("sessions", "slot=? AND id=?", keys(slot, id));
        });
    }

    private static void commitMerge(SQLiteDatabase db, int active, int staged) throws Exception {
        transaction(db, () -> {
            db.execSQL("DELETE FROM sessions WHERE slot=? AND id IN (SELECT id FROM sessions WHERE slot=?)",
                new Object[]{active, staged});
            db.execSQL("INSERT INTO sessions SELECT ?,id,title,created,updated,data FROM sessions WHERE slot=?",
                new Object[]{active, staged});
            db.execSQL("INSERT INTO refs SELECT ?,session,file FROM refs WHERE slot=?",
                new Object[]{active, staged});
            db.execSQL("INSERT OR IGNORE INTO files SELECT ?,id,type,object,0 FROM files WHERE slot=?",
                new Object[]{active, staged});
            db.execSQL("UPDATE files SET type=(SELECT type FROM files AS src WHERE src.slot=? AND src.id=files.id),"
                + " object=(SELECT object FROM files AS src WHERE src.slot=? AND src.id=files.id)"
                + " WHERE slot=? AND id IN (SELECT id FROM files WHERE slot=? AND override=1)",
                new Object[]{staged, staged, active, staged});
            db.execSQL("UPDATE state SET token=NULL,revision=revision+1 WHERE id=1");
        });
    }

    private static void bumpRevision(SQLiteDatabase db) {
        db.execSQL("UPDATE state SET revision=revision+1 WHERE id=1");
    }

    private static void clearSlot(SQLiteDatabase db, int slot) {
        String[] args = {String.valueOf(slot)};
        db.delete("sessions", "slot=?", args);
        db.delete("files", "slot=?", args);
    }

    private void scheduleMaintenance(boolean sweep) {
        if (maintenanceQueued) return;
        maintenanceQueued = true;
        maintenance.execute(() -> {
            synchronized (this) {
                maintenanceQueued = false;
                try {
                    SQLiteDatabase db = database();
                    if (sweep) {
                        transaction(db, () -> {
                            for (String object : files.candidates()) {
                                db.execSQL("INSERT OR IGNORE INTO garbage SELECT ? WHERE NOT EXISTS "
                                    + "(SELECT 1 FROM files WHERE object=?)", new Object[]{object, object});
                            }
                        });
                    }
                    State state = state(db);
                    boolean retiring = state.token() == null && clearRetiredBatch(db, state.staged());
                    if (collectGarbage(db) || retiring) scheduleMaintenance(false);
                } catch (Exception error) {
                    Log.w(TAG, "Attachment cleanup will be retried", error);
                }
            }
        });
    }

    private static boolean clearRetiredBatch(SQLiteDatabase db, int slot) throws Exception {
        int[] counts = new int[2];
        transaction(db, () -> {
            String[] args = {String.valueOf(slot), String.valueOf(slot)};
            for (int i = 0; i < counts.length; i++) {
                String table = i == 0 ? "sessions" : "files";
                counts[i] = db.delete(table, "slot=? AND id IN (SELECT id FROM " + table
                    + " WHERE slot=? LIMIT " + CLEANUP_BATCH + ")", args);
            }
        });
        return counts[0] == CLEANUP_BATCH || counts[1] == CLEANUP_BATCH;
    }

    private boolean collectGarbage(SQLiteDatabase db) throws Exception {
        List<String> candidates = new ArrayList<>();
        try (Cursor cursor = db.rawQuery(
                "SELECT object FROM garbage WHERE NOT EXISTS "
                + "(SELECT 1 FROM files WHERE object=garbage.object) LIMIT " + CLEANUP_BATCH, null)) {
            while (cursor.moveToNext()) candidates.add(cursor.getString(0));
        }
        int[] removed = {0};
        transaction(db, () -> {
            db.execSQL("DELETE FROM garbage WHERE EXISTS (SELECT 1 FROM files WHERE object=garbage.object)");
            for (String object : candidates) {
                if (files.delete(object)) {
                    removed[0] += db.delete("garbage", "object=?", new String[]{object});
                }
            }
        });
        return removed[0] == CLEANUP_BATCH;
    }

    private interface Transaction {
        void run() throws Exception;
    }

    private static void transaction(SQLiteDatabase db, Transaction work) throws Exception {
        db.beginTransaction();
        try {
            work.run();
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }
}
