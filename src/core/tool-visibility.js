export class AllToolsVisibility {
    select({ catalog }) {
        return catalog.map((tool) => tool.name)
    }
}
