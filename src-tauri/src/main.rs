#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod app;
mod autostart;
mod commands;
mod files;
mod folder_order;
mod native;
mod note_import;
mod settings;
mod startup;
mod text_annotations;
mod text_drop;
mod text_encoding;
mod text_files;
mod text_session;
fn main() {
    app::run();
}
