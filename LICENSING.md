# Licensing status

The maintainer intends the new Better-YouPI-PG contributions to be freely reusable, including experimentation, modification, commercial use and renamed forks.

## New contributions

Original contributions authored for this fork by Raghav6upta are offered under the [MIT license for new contributions](LICENSES/MIT-new-contributions.txt), to the extent the contributor owns those rights. Keep the copyright and permission notice when redistributing those contributions. Renaming a fork is allowed; renaming does not remove attribution requirements.

This grant does **not** relicense upstream code or third-party dependencies.

## Upstream code

This project derives from [youpi-pg/YouPI-PG](https://github.com/youpi-pg/YouPI-PG), credited upstream to Gaurav and Zenuxs. The imported baseline is commit `91d543c`.

At review time, the imported repository had no LICENSE file and its package metadata said “Commercial.” Its public README linked to a missing LICENSE. Public visibility alone does not establish an MIT or other open-source grant.

An explicit upstream license or permission covering redistribution and relicensing still needs to be established before the whole repository can be advertised as MIT-licensed. Until then, this is a partial contribution grant, not an open-source license for the complete distribution.

See [GitHub's licensing guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository).

## Dependencies

Dependencies retain their own licenses. In particular, the current `libsignal` package declares GPL-3.0, and Berry SDK packages declare their respective licenses. The small logging patch does not change those terms. Distribution must account for those licenses separately.

The original root package license label is preserved as inherited metadata pending clarification; it is not a newly granted license or a complete statement of all files' terms.
