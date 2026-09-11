#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod app;
mod commands;
mod files;
mod native;
mod settings;
fn main() {
    app::run();
}
