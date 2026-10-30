package com.muhurata.timer;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LiveTimerPlugin.class); // the running clock in the notification shade
        registerPlugin(SaveFilePlugin.class); // Settings > History: backup files
        super.onCreate(savedInstanceState);
    }
}
