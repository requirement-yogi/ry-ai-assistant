REQUIREMENT YOGI INDEXING CONTEXTS — a key macro is only indexed in one of these three places:

1. TABLE — key macro in the FIRST column of a row:
   - column 2 is interpreted as the requirement DESCRIPTION
   - columns 3+ become PROPERTIES (label = column header, value = cell)
   - a header row is required so property columns get their labels

2. PARAGRAPH — key macro inside a paragraph:
   - the text following the macro is the DESCRIPTION
   - no properties possible in this context

3. HEADING — key macro inside a heading:
   - no description, no properties (title-only marker)

A macro placed anywhere else (list item, blockquote, code block) is NOT indexed.
