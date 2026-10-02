use std::collections::HashMap;

pub fn undisclosed(head: &[String], base: &[String], declared: &[String]) -> Vec<String> {
    let mut allowed = HashMap::<&str, usize>::new();
    for step in base.iter().chain(declared) {
        *allowed.entry(step).or_default() += 1;
    }

    let mut extra = Vec::new();
    for step in head {
        match allowed.get_mut(step.as_str()) {
            Some(count) if *count > 0 => *count -= 1,
            _ => extra.push(step.clone()),
        }
    }
    extra
}

#[cfg(test)]
mod tests {
    use super::undisclosed;

    #[test]
    fn removes_only_as_many_matching_steps_as_are_allowed() {
        assert_eq!(
            undisclosed(
                &[
                    "call:Send".into(),
                    "call:ClearCache".into(),
                    "call:ClearCache".into()
                ],
                &["call:Send".into()],
                &["call:ClearCache".into()]
            ),
            vec!["call:ClearCache"]
        );
    }
}
