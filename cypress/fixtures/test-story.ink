Hi, whoever's reading this. This is a test story for e2e testing.

* Enter site -> her
* Leave site -> credits

== her ==
I can't remember how I met her. Was it BEFORE or AFTER we moved?

    * [BEFORE] -> END
    * [AFTER] -> tell_you

== tell_you ==

She was interesting. Her way of looking at the world ennobles it.

    * Do they?
        -> no_reason
    * I don't know.
        -> infinite_grace

= infinite_grace

You know those kinds of people?

    * I was thrown for a loop.
        -> i_was_thrown_for_a_loop

= no_reason

I couldn't stop myself from thinking: is she for real?

    * I was thrown for a loop.
        -> i_was_thrown_for_a_loop

=== i_was_thrown_for_a_loop ===

Anna is one of those people who's marked for tragedy.

    * [Marked for tragedy.]
        -> marked_for_tragedy

=== marked_for_tragedy ===

Bad things just happened to her.

-> credits

== credits ==

* See you later, friend.
    -> actual_credits

= actual_credits
written and designed for testing

-> END
