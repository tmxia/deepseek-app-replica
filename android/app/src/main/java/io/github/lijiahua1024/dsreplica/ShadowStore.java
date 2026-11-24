package io.github.lijiahua1024.dsreplica;

import android.content.Context;
import android.util.Base64;
import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.util.regex.Pattern;
import org.json.JSONArray;

/** Reads the pre-SQLite Android mirror during the one-time migration. */
final class ShadowStore {
    private static final Pattern SESSION = Pattern.compile("[A-Za-z0-9_-]{1,128}\\.json");
    private static final Pattern ATTACHMENT = Pattern.compile("[A-Za-z0-9_-]{1,128}\\.bin");
    private static final int CHUNK_SIZE = 256 * 1024;
    private final File root;

    ShadowStore(Context context) {
        root = new File(context.getFilesDir(), "chat-shadow");
    }

    private static Pattern pattern(String directory) {
        return switch (directory) {
            case "sessions" -> SESSION;
            case "files" -> ATTACHMENT;
            default -> throw new IllegalArgumentException("Unknown legacy directory");
        };
    }

    String list(String directory) {
        Pattern pattern = pattern(directory);
        File dir = new File(root, directory);
        if (!dir.exists()) return "[]";
        String[] names = dir.list((parent, name) -> pattern.matcher(name).matches());
        if (names == null) return null;
        JSONArray ids = new JSONArray();
        for (String name : names) ids.put(name.substring(0, name.lastIndexOf('.')));
        return ids.toString();
    }

    // Empty string marks EOF. Null indicates an unreadable file.
    String readChunk(String path, long offset) {
        String[] parts = path.split("/", -1);
        if (parts.length != 2 || offset < 0 || !pattern(parts[0]).matcher(parts[1]).matches()) {
            return null;
        }
        try (RandomAccessFile file = new RandomAccessFile(new File(root, path), "r")) {
            if (offset >= file.length()) return "";
            byte[] chunk = new byte[(int) Math.min(CHUNK_SIZE, file.length() - offset)];
            file.seek(offset);
            file.readFully(chunk);
            return Base64.encodeToString(chunk, Base64.NO_WRAP);
        } catch (IOException e) {
            return null;
        }
    }

    boolean clearAll() {
        return deleteTree(root);
    }

    private static boolean deleteTree(File file) {
        if (!file.exists()) return true;
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children == null) return false;
            for (File child : children) {
                if (!deleteTree(child)) return false;
            }
        }
        return file.delete() || !file.exists();
    }
}
