package com.muhurata.timer;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Saving a file the page made (a backup, the sessions as CSV): the app's web
 * view can't download, so Android's own "Save to" screen asks where it goes
 * (Downloads, Drive, ...), and the text is written there.
 *
 * save({name, type, text}) resolves {saved: true}, or {saved: false} when
 * the person backs out.
 */
@CapacitorPlugin(name = "SaveFile")
public class SaveFilePlugin extends Plugin {

    @PluginMethod
    public void save(PluginCall call) {
        if (call.getString("text") == null) {
            call.reject("Nothing to save");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(call.getString("type", "application/octet-stream"));
        intent.putExtra(Intent.EXTRA_TITLE, call.getString("name", "muhurta.txt"));
        startActivityForResult(call, intent, "written");
    }

    @ActivityCallback
    private void written(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Uri uri = result.getData() == null ? null : result.getData().getData();
        JSObject out = new JSObject();
        if (result.getResultCode() != Activity.RESULT_OK || uri == null) {
            out.put("saved", false);
            call.resolve(out);
            return;
        }
        try (OutputStream stream = getContext().getContentResolver().openOutputStream(uri, "wt")) {
            if (stream == null) throw new java.io.IOException("no stream");
            stream.write(call.getString("text", "").getBytes(StandardCharsets.UTF_8));
            out.put("saved", true);
            call.resolve(out);
        } catch (Exception e) {
            call.reject("The file couldn't be saved there. Try another place.");
        }
    }
}
