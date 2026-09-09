# Phases

Plans for large tasks — one **folder per plan** (named by its title), one
**file per phase** (`Phase-N.md`). Each plan's `README.md` holds notes plus
its tracker link (`CC-task: #N`).

Managed by the cli phases CLI — mutate through it, not by hand:

    node <cli.mjs> phases create "Plan title" --task <N>
    node <cli.mjs> phases add "Phase title" "what done looks like"
    node <cli.mjs> phases add-sub "Subphase title" --phase 1
    node <cli.mjs> phases done 1.1
    node <cli.mjs> phases list
