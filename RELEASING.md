# Releasing Tide

Pushing a version tag builds the installer on GitHub and publishes it. Installed copies of Tide check for
updates shortly after they start and every 6 hours, then download the new version and install it when
the person restarts Tide.

## One-time setup

1. Create a new **public** repository on GitHub, for example `tide-browser`. It has to be public, because
   Tide downloads updates without signing in.
2. In this folder, put the project in it (replace `YOUR-NAME` with your GitHub username):

   ```bash
   git init -b main
   git add .
   git commit -m "Tide Browser"
   git remote add origin https://github.com/YOUR-NAME/tide-browser.git
   git push -u origin main
   ```

3. On GitHub, open the repository, then Settings > Actions > General, and make sure Actions are allowed.
4. Turn on two-factor sign-in for your GitHub account. Whoever controls this repository controls what
   every installed copy of Tide installs.

You do not need to edit the `owner` and `repo` placeholders in `package.json` or create any token. The
release workflow fills them in from the repository it runs in.

## Each release

1. Raise `"version"` in `package.json`. It must be higher than the version people already have.
2. Commit and tag it, then push both. The tag must be the version with a `v` in front:

   ```bash
   git add package.json
   git commit -m "Release 1.0.3"
   git tag v1.0.3
   git push origin main --tags
   ```

3. Open the Actions tab on GitHub and watch the run. It takes about 5 to 10 minutes.
4. When it finishes, the Releases page shows the installer, its `.blockmap` file and `latest.yml`.
   Installed copies pick it up on their next check.

If the run fails on the tag check, the tag and the version in `package.json` do not match. Fix the
version, commit, delete the tag (`git tag -d v1.0.3` and `git push origin :refs/tags/v1.0.3`), and tag again.

## Things to know

- Copies of Tide installed before the update feature was added cannot update themselves. They need one
  manual install of a newer installer.
- The installer is not code-signed yet, so Windows may show a "Windows protected your PC" warning on the
  first download. Updates installed by Tide itself usually do not.
- To try a build without publishing, run `npm run dist` on your own PC. The installer lands in `dist`.

## The Mac version

The same tag also builds the Mac version. After the Windows job finishes, a second job runs on a Mac machine
that GitHub provides, and adds four files to the same release: a `.dmg` and a `.zip` for Apple Silicon
(`arm64`) and for Intel (`x64`). People open the `.dmg` and drag Tide into Applications.

- You cannot build the Mac version on Windows. Either push a tag and let GitHub do it, or run
  `npm run dist:mac` on a Mac.
- The Mac app is not signed with an Apple Developer ID (99 US dollars a year). It carries an ad-hoc signature so
  it can start on Apple Silicon, but macOS shows "Tide can't be opened because Apple cannot check it for
  malicious software" the first time. People open it with right-click > Open, or System Settings > Privacy &
  Security > Open Anyway. Signing and notarizing removes that, and is the one thing to buy before a public Mac release.
- For the same reason a Mac copy cannot update itself yet. It checks for new versions and shows a
  "Download update" button that opens the releases page. When the app is signed, set `MAC_SIGNED = true` in
  `src/updater.js` and updates install by themselves like on Windows.
- Nobody has run the Mac build yet. Expect a small fix or two after the first real run on a Mac.
