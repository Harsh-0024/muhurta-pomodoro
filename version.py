__version__ = "1.17.2"

# Which kind of copy this is. Everyone gets "stable" (main, released by a v*
# tag). Builds of the testing branch say "test": the Test builds part of
# .github/workflows/release.yml sets these two lines before building. A test
# copy installs next to the real app under its own name, keeps its own data
# folder on this device, never offers updates, and is downloaded by admins from
# the website's Testers page.
CHANNEL = "stable"
TEST_BUILD = 0  # which test build of this version (the workflow's run number)

IS_TEST = CHANNEL == "test"
APP_NAME = "Muhurta Pomodoro Test" if IS_TEST else "Muhurta Pomodoro"
DATA_DIR_NAME = "MuhurataTimer-Test" if IS_TEST else "MuhurataTimer"
# What the app shows as its version: "1.18.0", or "1.18.0 test 7".
DISPLAY_VERSION = f"{__version__} test {TEST_BUILD}" if IS_TEST else __version__
