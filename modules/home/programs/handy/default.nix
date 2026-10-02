{ pkgs, lib, config, ... }:
let
  # API keys, the provider list the app ships, onboarding state, and each
  # shortcut's default and label stay out.
  settings = {
    always_on_microphone = false;
    app_language = "en-FR";
    append_trailing_space = false;
    audio_feedback = true;
    audio_feedback_volume = 0.05000000074505806;
    auto_submit = false;
    auto_submit_key = "enter";
    autostart_enabled = true;
    bindings = {
      cancel = {
        current_binding = "escape";
      };
      transcribe = {
        current_binding = "ctrl_left+fn+f5";
      };
      transcribe_with_post_process = {
        current_binding = "option+shift+space";
      };
    };
    clamshell_microphone = null;
    clipboard_handling = "dont_modify";
    custom_filler_words = null;
    custom_words = [ ];
    debug_mode = false;
    experimental_enabled = false;
    external_script_path = null;
    extra_recording_buffer_ms = 0;
    filler_word_removal_enabled = true;
    history_limit = 5;
    hold_threshold_ms = 300;
    keyboard_implementation = "handy_keys";
    lazy_stream_close = false;
    log_level = "debug";
    model_unload_timeout = "min5";
    mute_while_recording = false;
    ort_accelerator = "auto";
    overlay_position = "bottom";
    overlay_style = "live";
    paste_delay_after_ms = 60;
    paste_delay_ms = 60;
    paste_method = "ctrl_v";
    post_process_enabled = false;
    post_process_prompts = [
      {
        id = "default_improve_transcriptions";
        name = "Improve Transcriptions";
        prompt = lib.removeSuffix "\n" (builtins.readFile ./improve-transcriptions.txt);
      }
    ];
    post_process_provider_id = "openai";
    post_process_selected_prompt_id = null;
    recording_retention_period = "preserve_limit";
    reliable_paste = false;
    selected_channel = null;
    selected_language = "auto";
    selected_microphone = null;
    selected_model = "handy-computer/nemotron-3.5-asr-streaming-0.6b-gguf/nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf";
    selected_output_device = null;
    shortcut_activation = "hold_or_toggle";
    show_tray_icon = true;
    show_whats_new_on_update = true;
    sound_theme = "marimba";
    start_hidden = false;
    theme = "system";
    transcribe_accelerator = "auto";
    transcribe_gpu_device = null;
    translate_to_english = false;
    typing_tool = "auto";
    update_checks_enabled = true;
    vad_backend = "silero";
    vad_enabled = true;
    word_correction_threshold = 0.18;
  };

  managed = (pkgs.formats.json { }).generate "handy-settings.json" { inherit settings; };
  merge = import ../../lib/merge-json.nix { inherit pkgs; };
in
{
  nixconfig.sync.handy = {
    method = "json-merge";
    managed = { inherit settings; };
    live = "~/Library/Application Support/com.pais.handy/settings_store.json";
    repo = "modules/home/programs/handy/default.nix";
    ignore = [
      "^settings\\.(post_process_api_keys|post_process_providers|post_process_models|onboarding_completed|whats_new_last_seen_version|settings_schema_version)$"
      "^settings\\.bindings\\.[^.]+\\.(default_binding|description|id|name)$"
    ];
  };

  # Handy rewrites the whole store, so merge into it instead of replacing it.
  home.activation.handyConfig = lib.hm.dag.entryAfter [ "writeBoundary" ]
    (merge managed "${config.home.homeDirectory}/Library/Application Support/com.pais.handy/settings_store.json");
}
