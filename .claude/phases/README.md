# Phases

Plans for large tasks — one **folder per plan** (named by its title), one
**file per phase** (`Phase-N.md`). Each plan's `README.md` holds notes plus
its tracker link (`CC-task: #N`).

Managed by the cc-phases CLI — mutate through it, not by hand:

    node <scripts>/cc-phases.mjs create "Plan title" --task <N>
    node <scripts>/cc-phases.mjs add "Phase title" "what done looks like"
    node <scripts>/cc-phases.mjs add-sub "Subphase title" --phase 1
    node <scripts>/cc-phases.mjs done 1.1
    node <scripts>/cc-phases.mjs list
