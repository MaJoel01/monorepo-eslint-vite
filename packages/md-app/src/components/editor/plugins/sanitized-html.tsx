import { createPlatePlugin } from "@udecode/plate-core/react";
import { PlateLeaf, PlateLeafProps } from "@udecode/plate/react";
// import { textAlign } from "html2canvas/dist/types/css/property-descriptors/text-align";

export const SanitizedElementLeaf = ({
	className,
	// @ts-expect-error -- the type seem to wrong
	element,
	...props
}: PlateLeafProps) => {

	const singleElRegex =
		/<\s*\/?\s*([a-zA-Z0-9]+)((?:\s+[a-zA-Z-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?\s*>/i;
	const attributeRegex = /([a-zA-Z-]+)\s*=\s*(['"])(.*?)\2/g;


	const singleElMatch = singleElRegex.exec(element.value);

	if (singleElMatch?.[1].toLowerCase() === "img") {
		const attributesString = singleElMatch[2] || "";
		const attributes: Record<string, string> = {};

		let attrMatch;
		while ((attrMatch = attributeRegex.exec(attributesString)) !== null) {
			attributes[attrMatch[1]] = attrMatch[3]; // Capture attribute name & value
		}

		// debugger;
		return (
			<PlateLeaf className={className} {...props} attributes={{
				...props.attributes,
				contentEditable: false,
				asChild: true,
			}}>
				<>
					<span style={{ display: "inline-block", textAlign: "initial" }}>
						<img
							{...attributes} // Spread the attributes onto the <img> element
						/>
					</span>
				</>
			</PlateLeaf>
		);
	}
	return (
		<PlateLeaf className={className}  {...props} attributes={{
			...props.attributes,
			contentEditable: false,
			asChild: true,
		}}>
			<code>
				<pre className="whitespace-pre-wrap">{element.value}</pre>
			</code>
		</PlateLeaf>
	);
};

export const SanitizedInlineHtmlPlugin = createPlatePlugin({
	key: "sanitized_inline_html",
	node: {
		component: SanitizedElementLeaf,
		isElement: true,
		// set to true to not return early here: https://github.com/udecode/plate/blob/72e7ec523daebe9c6cf276bb020a99ce52b1ff01/packages/markdown/src/lib/serializer/serializeMdNode.ts#L218
		isVoid: true,
		isInline: true,
	},
});

export const SanitizedBlockHtmlPlugin = createPlatePlugin({
	key: "sanitized_block_html",
	node: {
		component: SanitizedElementLeaf,
		isElement: true,
		// set to true to not return early here: https://github.com/udecode/plate/blob/72e7ec523daebe9c6cf276bb020a99ce52b1ff01/packages/markdown/src/lib/serializer/serializeMdNode.ts#L218
		isVoid: true,
		isInline: false,
	},
});


export const SanitizedBlockPlugin = createPlatePlugin({
	key: "sanitized_block",
	node: {
		component: SanitizedElementLeaf,
		isElement: true,
		// set to true to not return early here: https://github.com/udecode/plate/blob/72e7ec523daebe9c6cf276bb020a99ce52b1ff01/packages/markdown/src/lib/serializer/serializeMdNode.ts#L218
		isVoid: true,
		isInline: false,
	},
});
