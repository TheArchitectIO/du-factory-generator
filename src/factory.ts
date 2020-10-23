/**
 * factory.ts
 * Generate a factory graph using a recursive algorithm.
 * lgfrbcsgo & Nikolaus - October 2020
 */

import { Craftable, isOre, Item } from "./items"
import { findRecipe } from "./recipes"
import {
    ContainerNode,
    FactoryGraph,
    PerMinute,
    TransferNode,
    TransferContainerNode,
    isTransferContainerNode,
    MAX_CONTAINER_LINKS,
    MAX_INDUSTRY_LINKS,
} from "./graph"

/**
 * Add to the factory graph all nodes required to increase production of an item by a given rate.
 * Recursively call this function to produce all ingredients.
 * @param item Item to produce
 * @param rate Rate of increased production
 * @param factory the FactoryGraph
 */
function produce(item: Item, rate: PerMinute, factory: FactoryGraph): ContainerNode[] {
    /* Get containers already storing this item */
    const containers = factory.getContainers(item)

    /* Return a container(s) for ores, or create a new one(s) */
    if (isOre(item)) {
        for (const container of containers) {
            if (container.canAddOutgoingLinks(1)) {
                return [container]
            }
        }
        return [factory.createContainer(item)]
    }

    /* Increase egress of existing container if possible */
    for (const container of containers) {
        if (container.egress + rate < container.ingress && container.canAddOutgoingLinks(1)) {
            return [container]
        }
    }

    /* Create producers to existing container if possible */
    const recipe = findRecipe(item)
    let outputs: ContainerNode[] = []
    let additionalIndustries = 0
    for (const container of containers) {
        additionalIndustries = Math.ceil(
            (rate + container.egress - container.ingress) / (recipe.product.quantity / recipe.time),
        )
        if (
            container.canAddIncomingLinks(additionalIndustries) &&
            container.canAddOutgoingLinks(1)
        ) {
            outputs.push(container)
            break
        }
    }

    /* Create a new output container(s) if necessary */
    if (outputs.length === 0) {
        // The maximum number of required industries
        additionalIndustries = Math.ceil(rate / (recipe.product.quantity / recipe.time))

        // Add split containers if maxAdditionalIndustries exceeds limit
        if (additionalIndustries > MAX_CONTAINER_LINKS) {
            const numContainers = Math.ceil(additionalIndustries / MAX_CONTAINER_LINKS)
            const evenLinks = Math.ceil(additionalIndustries / numContainers)
            let linksRemaining = additionalIndustries
            for (let i = 0; i < numContainers; i++) {
                const numLinks = Math.min(evenLinks, linksRemaining)
                const split = numLinks / additionalIndustries
                outputs.push(factory.createSplitContainer(item, split))
                linksRemaining += -numLinks
            }
        } else {
            outputs.push(factory.createContainer(item))
        }
    }

    for (let i = 0; i < additionalIndustries; i++) {
        const industry = factory.createIndustry(item)
        industry.outputTo(outputs[i % outputs.length])
        /* Build dependencies recursively */
        for (const ingredient of recipe.ingredients) {
            const inputs = produce(ingredient.item, ingredient.quantity / recipe.time, factory)
            for (const input of inputs) {
                industry.takeFrom(input)
            }
        }
    }
    return outputs
}

/**
 * Add transfer units to remove byproducts from industry outputs
 * @param factory the FactoryGraph
 */
function handleByproducts(factory: FactoryGraph) {
    /* Loop over all factory containers */
    for (const container of factory.containers) {
        /* Ore containers have no byproducts */
        if (isOre(container.item)) {
            continue
        }
        const recipe = findRecipe(container.item)
        for (const byproduct of recipe.byproducts) {
            /* Check if byproduct is already being consumed */
            let isConsumed = false
            for (const consumer of container.consumers) {
                if (consumer.item === byproduct.item) {
                    isConsumed = true
                }
            }
            if (!isConsumed) {
                /* Check if there is already a transfer unit for this item */
                let transfer: TransferNode | undefined
                const itemTransfers = factory.getTransferUnits(byproduct.item)
                for (const itemTransfer of itemTransfers) {
                    if (itemTransfer.canAddIncomingLinks(1)) {
                        transfer = itemTransfer
                    }
                }
                /* Create a new transfer unit if necessary */
                if (transfer === undefined) {
                    transfer = factory.createTransferUnit(byproduct.item)
                    /* Find an output container that has space for an incoming link */
                    let output: ContainerNode | undefined
                    const itemContainers = factory.getContainers(byproduct.item)
                    for (const itemContainer of itemContainers) {
                        if (itemContainer.canAddIncomingLinks(1)) {
                            output = itemContainer
                        }
                    }
                    /* Create a new container if necessary */
                    if (output === undefined) {
                        output = factory.createContainer(byproduct.item)
                    }
                    transfer.outputTo(output)
                }
                transfer.takeFrom(container)
            }
        }
    }
}

/**
 * Add transfer units and containers to handle industries that require
 * >7 incoming links
 * @param factory the FactoryGraph
 */
function handleIndustryLinks(factory: FactoryGraph): void {
    // Loop over all factory industries
    for (const industry of factory.industries) {
        // Get ingredients and ingredient quantities
        const recipe = findRecipe(industry.item)
        // Sort ingredients by quantity
        const recipeIngredients = recipe.ingredients
        recipeIngredients.sort((a, b) => a.quantity - b.quantity)
        const ingredients = recipeIngredients.map((ingredient) => ingredient.item)

        // Get exceeding link count
        const exceedingLinks = industry.incomingLinkCount - MAX_INDUSTRY_LINKS
        if (exceedingLinks > 0) {
            let transferContainer: TransferContainerNode | undefined

            // Get all transfer containers containing a subset of the industry ingredients
            const transferContainers = factory.getTransferContainers(new Set(ingredients))
            for (const checkTransferContainer of transferContainers) {
                // Check if this transfer container has at least exceedingLinks+1 items
                // +1 because we need to remove one link to make space for TransferContainerNode
                if (checkTransferContainer.items.length < exceedingLinks + 1) {
                    continue
                }
                // Check if we can add an outgoing link from this TransferContainerNode
                if (!checkTransferContainer.canAddOutgoingLinks(1)) {
                    continue
                }
                // Check if we can add one ingoing link to each transfer unit on this TransferContainerNode
                if (
                    Array.from(checkTransferContainer.producers).some(
                        (node) => !node.canAddIncomingLinks(1),
                    )
                ) {
                    continue
                }
                // good
                transferContainer = checkTransferContainer
                break
            }

            // Create a new TransferContainerNode if necessary
            if (transferContainer === undefined) {
                // Use first exceedingLinks+1 items in ingredients (sorted by quantity)
                // +1 because we need to remove one link to make space for TransferContainerNode
                const items = ingredients.slice(0, exceedingLinks + 1)
                transferContainer = factory.createTransferContainer(items)
                // Add transfer units
                for (const item of items) {
                    const transferUnit = factory.createTransferUnit(item)
                    transferUnit.outputTo(transferContainer)
                }
            }

            // Remove existing container->industry links, and replace with
            // container->transfer unit links
            for (const transferUnit of transferContainer.producers) {
                let check = false
                for (const container of industry.inputs) {
                    if (isTransferContainerNode(container)) {
                        continue
                    }
                    if (container.item === transferUnit.item) {
                        container.consumers.delete(industry)
                        industry.inputs.delete(container)
                        transferUnit.takeFrom(container)
                        check = true
                        break
                    }
                }
                if (!check) {
                    console.log(industry)
                    console.log(transferUnit)
                    throw new Error("Unable to transfer item")
                }
            }

            // Link transfer container to industry
            industry.takeFrom(transferContainer)
        }
    }
}

/**
 * Sanity check the factory. Check for 1) exceeding container limits,
 * 2) egress > ingress, 3) or split containers having more than one consumer
 * @param factory the FactoryGraph
 */
function sanityCheck(factory: FactoryGraph): void {
    // Check containers
    for (const container of factory.containers) {
        if (container.incomingLinkCount > MAX_CONTAINER_LINKS) {
            console.log(container)
            throw new Error("Container exceeds incoming link limit")
        }
        if (container.outgoingLinkCount > MAX_CONTAINER_LINKS) {
            console.log(container)
            throw new Error("Container exceeds outgoing link limit")
        }
        if (container.egress > container.ingress) {
            console.log(container)
            throw new Error("Container egress exceeds ingress")
        }
        if (container.isSplit && container.outgoingLinkCount > 1) {
            console.log(container)
            throw new Error("Split container has more than one outgoing link")
        }
    }
    // Check industries
    for (const industry of factory.industries) {
        if (industry.incomingLinkCount > MAX_INDUSTRY_LINKS) {
            console.log(industry)
            throw new Error("Industry exceeds incoming link limit")
        }
    }
}

/**
 * Generate a new factory graph that supplies a given number of assemblers
 * for a given set of products
 * @param requirements Products and number of assemblers
 */
export function buildFactory(
    requirements: Map<Craftable, { count: number; maintain: number }>,
): FactoryGraph {
    const factory = new FactoryGraph()
    for (const [item, { count, maintain }] of requirements) {
        const recipe = findRecipe(item)
        const rate = recipe.product.quantity / recipe.time
        // Add an output node
        const output = factory.createOutput(item, rate * count, maintain)

        for (let i = 0; i < count; i++) {
            // Add industry, output to OutputNode
            const industry = factory.createIndustry(item)
            industry.outputTo(output)
            // Build ingredients
            for (const ingredient of recipe.ingredients) {
                const inputs = produce(ingredient.item, ingredient.quantity / recipe.time, factory)
                for (const input of inputs) {
                    industry.takeFrom(input)
                }
            }
        }
    }
    /* Add transfer units to relocate byproducts */
    handleByproducts(factory)
    /* Add transfer units and containers to handle industry link limit */
    handleIndustryLinks(factory)
    /* Sanity check for errors in factory */
    sanityCheck(factory)
    return factory
}
