package io.github.lijiahua1024.dsreplica;

import android.system.Os;
import android.system.OsConstants;
import android.util.Base64;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;

/** Immutable attachment bytes, referenced by SQLite only after a durable write. */
final class ChatFiles {
    private static final Pattern TOKEN = Pattern.compile("[0-9a-f-]{36}");
    private record Upload(Object owner, FileOutputStream stream) {}

    private final File directory;
    private final Map<String, Upload> uploads = new HashMap<>();

    ChatFiles(File filesDir) {
        directory = new File(filesDir, "chat-attachments");
    }

    String begin(Object owner) throws IOException {
        if (!directory.isDirectory() && !directory.mkdir()) {
            throw new IOException("Unable to create the attachment directory");
        }
        String token = UUID.randomUUID().toString();
        uploads.put(token, new Upload(owner, new FileOutputStream(file(token))));
        return token;
    }

    void append(Object owner, String token, String data) throws IOException {
        Upload upload = uploads.get(token);
        if (upload == null || upload.owner() != owner || upload.stream() == null
                || data.length() > 350_000) {
            throw new IOException("Invalid attachment upload");
        }
        upload.stream().write(Base64.decode(data, Base64.NO_WRAP));
    }

    void prepare(Object owner, String token) throws IOException {
        Upload upload = uploads.get(token);
        if (upload == null || upload.owner() != owner || upload.stream() == null) {
            throw new IOException("Attachment upload is unavailable");
        }
        upload.stream().getFD().sync();
        upload.stream().close();
        uploads.put(token, new Upload(owner, null));
    }

    void syncDirectory() throws Exception {
        for (File path : new File[]{directory, directory.getParentFile()}) {
            FileDescriptor fd = Os.open(path.getPath(), OsConstants.O_RDONLY, 0);
            try {
                Os.fsync(fd);
            } finally {
                Os.close(fd);
            }
        }
    }

    void committed(String token) {
        uploads.remove(token);
    }

    void abandon(Object owner, String token) {
        Upload upload = uploads.get(token);
        if (upload == null || upload.owner() != owner) return;
        uploads.remove(token);
        // A prepared file may be referenced if SQLite reported an ambiguous commit failure.
        if (upload.stream() == null) return;
        try {
            upload.stream().close();
        } catch (IOException ignored) {
            // The file has no committed reference and can be reclaimed.
        }
        delete(token);
    }

    void abandonAll(Object owner) {
        for (String token : uploads.keySet().toArray(new String[0])) {
            abandon(owner, token);
        }
    }

    InputStream open(String token) throws IOException {
        if (!TOKEN.matcher(token).matches() || uploads.containsKey(token)) {
            throw new IOException("Invalid attachment path");
        }
        return new FileInputStream(file(token));
    }

    String[] candidates() {
        String[] names = directory.list((dir, name) -> TOKEN.matcher(name).matches());
        return names == null ? new String[0] : names;
    }

    boolean delete(String token) {
        if (uploads.containsKey(token)) return false;
        File file = file(token);
        return file.delete() || !file.exists();
    }

    private File file(String token) {
        return new File(directory, token);
    }
}
